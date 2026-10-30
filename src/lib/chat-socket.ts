// ============================================================
// ChatSocket — socket.io-style shim over native WebSocket,
// purpose-built for the Cloudflare Workers backend:
//   - one permanent WebSocket to the GLOBAL lobby Durable Object
//   - one lazy WebSocket to the current game room's Durable Object
//   - ack callbacks, auto-reconnect, seat resume, typing TTL,
//     heartbeat ping/pong, room probe over HTTP
// Same event surface the UI already knows: on/emit/disconnect/id
// ============================================================

type AckFn = (res: any) => void
type Handler = (data: any) => void

const COLORS = [
  '#d4af37', '#c0c0c0', '#cd7f32', '#10b981', '#a855f7',
  '#ef4444', '#ec4899', '#14b8a6', '#f97316', '#84cc16',
]

const PING_MS = 25_000
const PONG_TIMEOUT_MS = 70_000
const ACK_TIMEOUT_MS = 15_000
const TYPING_TTL_MS = 5_500

function randChars(n: number): string {
  const a = new Uint8Array(n)
  crypto.getRandomValues(a)
  let s = ''
  for (const b of a) s += (b % 36).toString(36)
  return s
}

function wsUrl(room: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/chat?room=${encodeURIComponent(room)}`
}

export class ChatSocket {
  /** stable identity used across both transports (global + room) */
  id: string

  private handlers = new Map<string, Set<Handler>>()
  private uid = randChars(12)
  private ckG = randChars(20)
  private ckR = randChars(20)
  private color: string
  private adminToken: string | null = null

  private gws: WebSocket | null = null
  private rws: WebSocket | null = null
  private gOpen = false
  private gEverOpened = false
  private roomCode: string | null = null
  private rOpening = false
  private rOpen = false

  private gQueue: string[] = []
  private rQueue: string[] = []
  private gAck = new Map<number, AckFn>()
  private rAck = new Map<number, AckFn>()
  private ackSeq = 1

  private gBackoff = 600
  private rBackoff = 600
  private destroyed = false

  private session: { code: string; name: string; password?: string; token?: string } | null = null

  private pingTimer: ReturnType<typeof setInterval> | null = null
  private touchTimer: ReturnType<typeof setInterval> | null = null
  private lastPongG = 0
  private lastPongR = 0
  private typingSeq: Record<string, number> = { global: 0, room: 0 }

  constructor() {
    this.id = this.uid
    try {
      const saved = localStorage.getItem('mc_color')
      this.color = saved && COLORS.includes(saved) ? saved : COLORS[Math.floor(Math.random() * COLORS.length)]
      localStorage.setItem('mc_color', this.color)
    } catch {
      this.color = COLORS[Math.floor(Math.random() * COLORS.length)]
    }
    this.connectGlobal()
    this.pingTimer = setInterval(() => this.heartbeat(), PING_MS)
    // liveness touch: wakes the DO so zombie seats never outlive a dead tab
    this.touchTimer = setInterval(() => {
      const t = JSON.stringify({ ev: 'touch', uid: this.uid, ck: this.ckG })
      if (this.gOpen && this.gws?.readyState === WebSocket.OPEN) {
        try {
          this.gws.send(t)
        } catch { /* ignore */ }
      }
      if (this.rOpen && this.rws?.readyState === WebSocket.OPEN) {
        try {
          this.rws.send(JSON.stringify({ ev: 'touch', uid: this.uid, ck: this.ckR }))
        } catch { /* ignore */ }
      }
    }, 60_000)
  }

  // ============ public API (socket.io surface) ============
  on(ev: string, cb: Handler) {
    let set = this.handlers.get(ev)
    if (!set) {
      set = new Set()
      this.handlers.set(ev, set)
    }
    set.add(cb)
  }

  emit(ev: string, d?: any, ack?: AckFn) {
    switch (ev) {
      case 'join-global':
        this.sendG(ev, d, ack)
        return
      case 'admin-login':
        // owner login goes over the global transport; crown the room seat too
        this.sendG(ev, d, (res: any) => {
          if (res?.ok && res?.token) {
            this.adminToken = res.token
            if (this.rOpen && this.rws) {
              try {
                this.rws.send(
                  JSON.stringify({ ev: 'admin-upgrade', d: { token: res.token }, uid: this.uid, ck: this.ckR })
                )
              } catch { /* ignore */ }
            }
          }
          ack?.(res)
        })
        return
      case 'admin-action':
        // super-admin moderation — same global transport, token in the payload
        this.sendG(ev, d, ack)
        return
      case 'create-room':
        void this.handleCreate(d, ack)
        return
      case 'join-room':
        this.handleJoin(d, ack)
        return
      case 'check-room':
        void this.handleCheck(d, ack)
        return
      case 'send-message':
      case 'set-typing': {
        if (d?.scope === 'global') {
          this.sendG(ev, d)
        } else if (this.rOpen) {
          this.rawR(this.frame(ev, d))
        }
        return
      }
      case 'leave-room':
        this.leaveRoom()
        return
      default:
        return
    }
  }

  disconnect() {
    this.destroyed = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.touchTimer) clearInterval(this.touchTimer)
    try {
      this.gws?.close()
    } catch { /* ignore */ }
    try {
      this.rws?.close()
    } catch { /* ignore */ }
    this.handlers.clear()
    this.gAck.clear()
    this.rAck.clear()
  }

  // ============ frames / acks ============
  private frame(ev: string, d?: any): string {
    return JSON.stringify({ ev, d, uid: this.uid, ck: this.ckR })
  }

  private registerAck(map: Map<number, AckFn>, ack?: AckFn): number | null {
    if (!ack) return null
    const a = this.ackSeq++
    const t: any = setTimeout(() => {
      if (map.has(a)) {
        map.delete(a)
        ack({ ok: false, error: 'SERVER_BUSY' })
      }
    }, ACK_TIMEOUT_MS)
    map.set(a, (res: any) => {
      clearTimeout(t)
      map.delete(a)
      ack(res)
    })
    return a
  }

  private sendG(ev: string, d?: any, ack?: AckFn) {
    const a = this.registerAck(this.gAck, ack)
    const s = JSON.stringify({ ev, d, a, uid: this.uid, ck: this.ckG })
    if (this.gOpen && this.gws?.readyState === WebSocket.OPEN) this.gws.send(s)
    else this.gQueue.push(s)
  }

  private rawR(s: string) {
    if (this.rOpen && this.rws?.readyState === WebSocket.OPEN) this.rws.send(s)
    else this.rQueue.push(s)
  }

  private emitLocal(ev: string, d?: any) {
    const set = this.handlers.get(ev)
    if (!set) return
    for (const cb of Array.from(set)) {
      try {
        cb(d)
      } catch {
        /* listener error must not kill the shim */
      }
    }
  }

  // ============ GLOBAL transport ============
  private connectGlobal() {
    if (this.destroyed) return
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl('GLOBAL'))
    } catch {
      this.scheduleGlobal()
      return
    }
    this.gws = ws
    ws.onmessage = (e) => {
      this.lastPongG = Date.now()
      if (e.data === 'pong') return
      let m: any
      try {
        m = JSON.parse(e.data as string)
      } catch {
        return
      }
      if (m?.t === 'ack') {
        const fn = this.gAck.get(m.a)
        if (fn) fn(m.d)
        return
      }
      if (m?.t === 'ev') {
        if (m.ev === 'hello') {
          const first = !this.gEverOpened
          this.gEverOpened = true
          this.gOpen = true
          this.gBackoff = 600
          this.flushG()
          this.emitLocal('connect')
          if (first) return
        }
        if (m.ev === 'typing') this.armTypingTtl(m.d)
        this.emitLocal(m.ev, m.d)
      }
    }
    ws.onclose = () => {
      this.gOpen = false
      if (this.destroyed) return
      if (this.gEverOpened) this.emitLocal('disconnect')
      this.emitLocal('connect_error')
      this.scheduleGlobal()
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch { /* ignore */ }
    }
  }

  private scheduleGlobal() {
    if (this.destroyed) return
    const delay = this.gBackoff + Math.random() * 400
    this.gBackoff = Math.min(this.gBackoff * 1.8, 8000)
    setTimeout(() => this.connectGlobal(), delay)
  }

  private flushG() {
    const q = this.gQueue.splice(0)
    for (const s of q) {
      try {
        this.gws?.send(s)
      } catch {
        /* ignore */
      }
    }
  }

  // ============ ROOM transport ============
  private openRoom(code: string) {
    if (this.roomCode === code && (this.rOpening || this.rOpen)) return
    if (this.rws) {
      const old = this.rws
      this.rws = null
      this.rOpen = false
      try {
        old.close()
      } catch { /* ignore */ }
    }
    this.roomCode = code
    this.rOpening = true
    const delay = this.rBackoff > 600 ? this.rBackoff + Math.random() * 300 : 0
    setTimeout(() => this.connectRoom(code), delay)
  }

  private connectRoom(code: string) {
    if (this.destroyed || this.roomCode !== code) return
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl(code))
    } catch {
      this.rOpening = false
      this.roomRetry(code)
      return
    }
    this.rws = ws
    ws.onmessage = (e) => {
      this.lastPongR = Date.now()
      if (e.data === 'pong') return
      let m: any
      try {
        m = JSON.parse(e.data as string)
      } catch {
        return
      }
      if (m?.t === 'ack') {
        const fn = this.rAck.get(m.a)
        if (fn) fn(m.d)
        return
      }
      if (m?.t === 'ev') {
        if (m.ev === 'hello') {
          this.rOpening = false
          this.rOpen = true
          this.rBackoff = 600
          const q = this.rQueue.splice(0)
          for (const s of q) {
            try {
              ws.send(s)
            } catch { /* ignore */ }
          }
          return
        }
        if (m.ev === 'typing') this.armTypingTtl(m.d)
        this.emitLocal(m.ev, m.d)
      }
    }
    ws.onclose = () => {
      if (this.rws === ws) {
        this.rws = null
        this.rOpen = false
      }
      this.rOpening = false
      if (this.destroyed) return
      // seat sits in the 60s grace window — nudge the app to rejoin
      if (this.roomCode === code && this.gOpen) this.emitLocal('connect')
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch { /* ignore */ }
    }
  }

  private roomRetry(code: string) {
    this.rBackoff = Math.min(this.rBackoff * 1.8, 8000)
    setTimeout(() => {
      if (!this.destroyed && this.roomCode === code && !this.rOpen) {
        this.rOpening = true
        this.connectRoom(code)
      }
    }, this.rBackoff + Math.random() * 300)
  }

  private closeRoom() {
    this.roomCode = null
    this.session = null
    const ws = this.rws
    this.rws = null
    this.rOpen = false
    this.rOpening = false
    if (ws) {
      setTimeout(() => {
        try {
          ws.close()
        } catch { /* ignore */ }
      }, 250)
    }
  }

  private leaveRoom() {
    if (this.rOpen && this.rws) {
      try {
        this.rws.send(this.frame('leave-room'))
      } catch { /* ignore */ }
    }
    this.closeRoom()
  }

  // ============ flows ============
  private async handleCreate(d: any, ack?: AckFn) {
    let attempt = 0
    const run = async () => {
      try {
        const res = await fetch('/api/new-room', { cache: 'no-store' })
        const j = (await res.json()) as { ok?: boolean; code?: string }
        if (!j?.ok || !j.code) {
          ack?.({ ok: false, error: 'SERVER_BUSY' })
          return
        }
        const code = j.code
        this.openRoom(code)
        const a = this.registerAck(this.rAck, (res2: any) => {
          if (res2?.ok) {
            this.session = { code, name: d?.name, password: d?.password, token: res2.token }
          } else if (res2?.error === 'ROOM_EXISTS' && ++attempt < 3) {
            void run()
            return
          } else {
            this.closeRoom()
          }
          ack?.(res2)
        })
        this.rawR(JSON.stringify({ ev: 'create-room', d, a, uid: this.uid, ck: this.ckR }))
      } catch {
        ack?.({ ok: false, error: 'SERVER_BUSY' })
      }
    }
    await run()
  }

  private handleJoin(d: any, ack?: AckFn) {
    const code = String(d?.roomCode ?? '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8)
    if (!code || code === 'GLOBAL' || code.length < 4) {
      ack?.({ ok: false, error: 'ROOM_NOT_FOUND' })
      return
    }
    this.openRoom(code)
    const a = this.registerAck(this.rAck, (res: any) => {
      if (res?.ok) {
        this.session = { code, name: d?.name, password: d?.password, token: res.token }
      } else {
        this.closeRoom()
      }
      ack?.(res)
    })
    this.rawR(JSON.stringify({ ev: 'join-room', d, a, uid: this.uid, ck: this.ckR }))
  }

  private async handleCheck(d: any, ack?: AckFn) {
    const code = String(d?.roomCode ?? '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8)
    if (!code || code === 'GLOBAL') {
      ack?.({ ok: true, exists: false, hasPassword: false })
      return
    }
    try {
      const res = await fetch(`/api/probe?code=${encodeURIComponent(code)}`, { cache: 'no-store' })
      const j = (await res.json()) as { exists?: boolean; hasPassword?: boolean }
      ack?.({ ok: true, exists: !!j.exists, hasPassword: !!j.hasPassword })
    } catch {
      ack?.({ ok: true, exists: false, hasPassword: false })
    }
  }

  // ============ heartbeat + typing TTL ============
  private heartbeat() {
    const now = Date.now()
    if (this.gws?.readyState === WebSocket.OPEN) {
      if (this.gOpen && now - this.lastPongG > PONG_TIMEOUT_MS) {
        try {
          this.gws.close()
        } catch { /* ignore */ }
      } else {
        try {
          this.gws.send('{"t":"ping"}')
        } catch { /* ignore */ }
      }
    }
    if (this.rws?.readyState === WebSocket.OPEN && this.rOpen) {
      if (now - this.lastPongR > PONG_TIMEOUT_MS) {
        try {
          this.rws.close()
        } catch { /* ignore */ }
      } else {
        try {
          this.rws.send('{"t":"ping"}')
        } catch { /* ignore */ }
      }
    }
  }

  private armTypingTtl(d: any) {
    const scope = d?.scope === 'global' ? 'global' : 'room'
    const names: string[] = Array.isArray(d?.names) ? d.names : []
    const seq = ++this.typingSeq[scope]
    if (names.length === 0) return
    setTimeout(() => {
      if (this.typingSeq[scope] === seq && !this.destroyed) {
        this.emitLocal('typing', { names: [], scope })
      }
    }, TYPING_TTL_MS)
  }
}
