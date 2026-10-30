// ============================================================
// ChatHub — a single Durable Object that hosts EVERYTHING:
// the permanent GLOBAL lobby, every game room, moderation
// (bans / freeze / broadcast) and the owner login.
// Native WebSockets + socket.io-style JSON frames, mirroring
// the sandbox socket.io service 1:1 (same events, same acks).
// ============================================================

const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const ROOM_CODE_LENGTH = 8
const MAX_USERS_PER_ROOM = 30
const MAX_GLOBAL_USERS = 100
const MAX_MESSAGES_KEPT = 500
const GLOBAL_PERSIST = 100
const MAX_ROOMS = 300
const NAME_MAX = 20
const CONTENT_MAX = 600
const SEND_COOLDOWN_MS = 350
const FLOOD_WINDOW_MS = 10_000
const FLOOD_MAX_MSGS = 8
const FLOOD_MUTE_MS = 15_000
const DUP_WINDOW_MS = 5_000
const TYPING_TTL_MS = 5_000
const GRACE_MS = 60_000
const GLOBAL_CODE = 'GLOBAL'

const COLORS = [
  '#d4af37', '#c0c0c0', '#cd7f32', '#10b981', '#a855f7',
  '#ef4444', '#ec4899', '#14b8a6', '#f97316', '#84cc16',
]

interface Msg {
  id: string
  userId: string
  name: string
  color: string
  content: string
  ts: number
  type: 'user' | 'system'
  isAdmin?: boolean
  scope?: 'room' | 'global'
}

interface Seat {
  uid: string
  name: string
  color: string
  admin: boolean
  token: string
  ws: WebSocket | null
  ip: string
  connected: boolean
  lastSeen: number
  typingUntil: number
  lastSentAt: number
  lastContent: string
  lastContentAt: number
  sendTimes: number[]
  mutedUntil: number
}

interface Rm {
  code: string
  ownerUid: string
  passwordHash: string | null
  messages: Msg[]
  users: Map<string, Seat> // uid -> seat
  touchedAt: number
}

interface Conn {
  ws: WebSocket
  uid: string
  scope: 'global' | 'room'
  roomCode: string
  ip: string
}

export interface Env {
  CHAT_HUB: DurableObjectNamespace
  ASSETS: Fetcher
  ADMIN_USER?: string
  ADMIN_PASS?: string
}

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const cleanName = (raw: unknown): string =>
  String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX)

const cleanContent = (raw: unknown): string =>
  String(raw ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, CONTENT_MAX)

const cleanPassword = (raw: unknown): string =>
  String(raw ?? '').replace(/[\u0000-\u001f\u007f\s]/g, '').slice(0, 16)

export class ChatHub {
  private ctx: DurableObjectState
  private env: Env
  private booted: Promise<void> | null = null

  private rooms = new Map<string, Rm>()
  private conns = new Map<WebSocket, Conn>()
  private pendingCodes = new Map<string, number>() // code -> created at
  private adminTokens = new Set<string>()

  private bannedUsers = new Set<string>()
  private bannedIPs = new Set<string>()
  private frozen = false

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
  }

  // ---------- boot (lazy, once) ----------
  private boot(): Promise<void> {
    if (!this.booted) {
      this.booted = (async () => {
        const globalRoom: Rm = {
          code: GLOBAL_CODE,
          ownerUid: '',
          passwordHash: null,
          messages: (await this.ctx.storage.get<Msg[]>('gm')) ?? [],
          users: new Map(),
          touchedAt: Date.now(),
        }
        this.rooms.set(GLOBAL_CODE, globalRoom)
        const [bu, bi, fz] = await Promise.all([
          this.ctx.storage.get<string[]>('bannedUsers'),
          this.ctx.storage.get<string[]>('bannedIPs'),
          this.ctx.storage.get<boolean>('frozen'),
        ])
        if (bu) this.bannedUsers = new Set(bu)
        if (bi) this.bannedIPs = new Set(bi)
        this.frozen = Boolean(fz)
        console.log(`[hub] booted — global history ${globalRoom.messages.length} msgs`)
      })()
    }
    return this.booted
  }

  private get global(): Rm {
    return this.rooms.get(GLOBAL_CODE)!
  }

  // ---------- persistence ----------
  private async persistGlobal() {
    await this.ctx.storage.put('gm', this.global.messages.slice(-GLOBAL_PERSIST))
  }

  private async persistModeration() {
    await this.ctx.storage.put('bannedUsers', Array.from(this.bannedUsers))
    await this.ctx.storage.put('bannedIPs', Array.from(this.bannedIPs))
    await this.ctx.storage.put('frozen', this.frozen)
  }

  // ---------- http entry ----------
  async fetch(req: Request): Promise<Response> {
    await this.boot()
    const url = new URL(req.url)
    const ip = req.headers.get('cf-connecting-ip') ?? ''
    const p = url.pathname

    // NOTE: the websocket request must be forwarded to the DO as the ORIGINAL
    // request — reconstructing it drops the Upgrade header (CF runtime rule).
    if (p === '/do/chat' || p === '/api/chat') {
      const room = (url.searchParams.get('room') || GLOBAL_CODE).toUpperCase().slice(0, 16)
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('expected websocket', { status: 426 })
      }
      const pair = new WebSocketPair()
      // NON-hibernating socket: the hub keeps everything in memory (rooms,
      // seats, moderation state) and stays alive while sockets are open.
      // Hibernation would wipe that state between messages.
      const server = pair[1]
      server.accept()
      server.addEventListener('message', (e) => {
        this.webSocketMessage(server, typeof e.data === 'string' ? e.data : '').catch((err) => {
          console.error('[hub] ws message error:', err instanceof Error ? err.stack : String(err))
        })
      })
      server.addEventListener('close', () => {
        void this.webSocketClose(server)
      })
      server.addEventListener('error', () => {
        void this.webSocketError(server)
      })
      const conn: Conn = { ws: server, uid: '', scope: room === GLOBAL_CODE ? 'global' : 'room', roomCode: room, ip }
      this.conns.set(server, conn)
      this.send(server, 'hello', { room })
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    if (p === '/do/new-room' || p === '/api/new-room') {
      let code = ''
      do {
        code = ''
        for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += pick(ROOM_ALPHABET)
      } while (this.rooms.has(code) || this.pendingCodes.has(code))
      this.pendingCodes.set(code, Date.now())
      await this.sweepSoon()
      return Response.json({ ok: true, code })
    }

    if (p === '/do/probe' || p === '/api/probe') {
      const code = (url.searchParams.get('code') || '').toUpperCase().slice(0, 16)
      const room = this.rooms.get(code)
      return Response.json({ exists: Boolean(room), hasPassword: Boolean(room?.passwordHash) })
    }

    return new Response('not found', { status: 404 })
  }

  // ---------- frame senders ----------
  private send(ws: WebSocket, ev: string, d?: unknown) {
    try {
      ws.send(JSON.stringify({ t: 'ev', ev, d }))
    } catch { /* socket already gone */ }
  }

  private ack(ws: WebSocket, a: unknown, d: unknown) {
    try {
      ws.send(JSON.stringify({ t: 'ack', a, d }))
    } catch { /* ignore */ }
  }

  private toConn(ws: WebSocket): Conn | undefined {
    return this.conns.get(ws)
  }

  private broadcast(room: Rm, ev: string, d: unknown, except?: WebSocket) {
    for (const seat of room.users.values()) {
      if (seat.ws && seat.ws !== except) this.send(seat.ws, ev, d)
    }
  }

  // ---------- shapes ----------
  private publicSeat(s: Seat) {
    return { id: s.uid, name: s.name, color: s.color, isAdmin: s.admin || undefined, connected: s.connected }
  }

  private usersPayload(room: Rm) {
    return {
      scope: room.code === GLOBAL_CODE ? 'global' : 'room',
      ownerId: room.ownerUid,
      users: Array.from(room.users.values()).map((s) => this.publicSeat(s)),
    }
  }

  private broadcastUsers(room: Rm) {
    this.broadcast(room, 'users', this.usersPayload(room))
  }

  private typingNames(room: Rm): string[] {
    const now = Date.now()
    const names: string[] = []
    for (const s of room.users.values()) {
      if (s.connected && s.typingUntil > now) names.push(s.name)
    }
    return names
  }

  private broadcastTyping(room: Rm) {
    this.broadcast(room, 'typing', {
      scope: room.code === GLOBAL_CODE ? 'global' : 'room',
      names: this.typingNames(room),
    })
  }

  private sys(content: string): Msg {
    return { id: genId(), userId: 'system', name: 'system', color: '#9c9a92', content, ts: Date.now(), type: 'system' }
  }

  private pushAndEmit(room: Rm, msg: Msg) {
    room.messages.push(msg)
    if (room.messages.length > MAX_MESSAGES_KEPT) {
      room.messages.splice(0, room.messages.length - MAX_MESSAGES_KEPT)
    }
    const scope = room.code === GLOBAL_CODE ? 'global' : 'room'
    this.broadcast(room, 'message', { ...msg, scope })
    if (room.code === GLOBAL_CODE) void this.persistGlobal()
  }

  // ---------- seat helpers ----------
  private freshSeat(uid: string, name: string, color: string, admin: boolean, ip: string, token: string): Seat {
    return {
      uid, name, color, admin, token, ws: null, ip, connected: false,
      lastSeen: Date.now(), typingUntil: 0,
      lastSentAt: 0, lastContent: '', lastContentAt: 0, sendTimes: [], mutedUntil: 0,
    }
  }

  private isBannedSocket(ip: string): boolean {
    return Boolean(ip) && this.bannedIPs.has(ip)
  }

  // a live connection joins/rejoins a room seat (uid-keyed, silent resume)
  private seatUp(room: Rm, conn: Conn, name: string, admin: boolean, silent: boolean): Seat {
    let seat = room.users.get(conn.uid)
    if (!seat) {
      seat = this.freshSeat(conn.uid, name, pick(COLORS), admin, conn.ip, genId())
      room.users.set(conn.uid, seat)
    } else {
      seat.name = name
      seat.ip = conn.ip
      if (admin) seat.admin = true
    }
    seat.ws = conn.ws
    seat.connected = true
    seat.lastSeen = Date.now()
    seat.typingUntil = 0
    seat.lastSentAt = 0
    seat.lastContent = ''
    seat.lastContentAt = 0
    seat.sendTimes = []
    seat.mutedUntil = 0

    if (room.code !== GLOBAL_CODE && !room.ownerUid) room.ownerUid = conn.uid

    if (!silent) {
      this.pushAndEmit(room, this.sys(`${name} joined the room 🎮`))
    }
    this.broadcastUsers(room)
    return seat
  }

  private leaveSeat(room: Rm, uid: string, announce: boolean) {
    const seat = room.users.get(uid)
    if (!seat) return
    room.users.delete(uid)
    if (announce) this.pushAndEmit(room, this.sys(`${seat.name} left the room 👋`))
    if (room.ownerUid === uid) {
      const next = room.users.values().next().value
      room.ownerUid = next ? next.uid : ''
    }
    if (room.users.size === 0 && room.code !== GLOBAL_CODE) {
      // keep the room alive through the grace window (refresh / tab re-open)
      room.touchedAt = Date.now()
      void this.sweepSoon()
      return
    }
    this.broadcastUsers(room)
  }

  // ---------- scheduling ----------
  private async sweepSoon() {
    const current = await this.ctx.storage.getAlarm()
    if (current === null) await this.ctx.storage.setAlarm(Date.now() + GRACE_MS)
  }

  async alarm() {
    const now = Date.now()
    for (const [code, room] of Array.from(this.rooms)) {
      if (code === GLOBAL_CODE) continue
      // drop seats whose ws is gone for longer than the grace window
      for (const [uid, seat] of Array.from(room.users)) {
        if ((!seat.ws || !seat.connected) && now - seat.lastSeen > GRACE_MS) {
          room.users.delete(uid)
        }
      }
      if (room.users.size === 0 && now - room.touchedAt > GRACE_MS) {
        this.rooms.delete(code)
        console.log(`[hub] room ${code} wiped`)
      } else if (room.users.size > 0) {
        this.broadcastUsers(room)
      }
    }
    for (const [code, at] of Array.from(this.pendingCodes)) {
      if (now - at > 30_000) this.pendingCodes.delete(code)
    }
  }

  // ---------- websocket lifecycle ----------
  async webSocketClose(ws: WebSocket) {
    const conn = this.conns.get(ws)
    if (!conn) return
    this.conns.delete(ws)
    const room = this.rooms.get(conn.roomCode)
    if (!room) return
    const seat = room.users.get(conn.uid)
    if (!seat || seat.ws !== ws) return

    if (conn.scope === 'global') {
      // the open lobby: seats are free, history stays
      room.users.delete(conn.uid)
      this.broadcastUsers(room)
      return
    }
    // game rooms: hold the seat for the grace window
    seat.ws = null
    seat.connected = false
    seat.lastSeen = Date.now()
    seat.typingUntil = 0
    this.broadcastUsers(room)
    void this.sweepSoon()
  }

  async webSocketError(ws: WebSocket) {
    try {
      ws.close()
    } catch { /* ignore */ }
    await this.webSocketClose(ws)
  }

  // ---------- message routing ----------
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    await this.boot()
    if (typeof raw !== 'string') return
    if (raw === 'ping' || raw === '{"t":"ping"}') {
      try {
        ws.send('pong')
      } catch { /* ignore */ }
      return
    }
    let m: { ev?: string; d?: any; a?: unknown; uid?: string }
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    const conn = this.toConn(ws)
    if (!conn) {
      console.log(`[hub] wsmsg '${m.ev}' — NO conn (stale socket after restart)`)
      return
    }
    if (m.ev !== 'touch') console.log(`[hub] wsmsg '${m.ev}' from ${conn.roomCode}`)
    if (m.uid) conn.uid = String(m.uid).slice(0, 24)

    switch (m.ev) {
      case 'touch':
        return
      case 'join-global':
        return this.onJoinGlobal(ws, conn, m.d, m.a)
      case 'admin-login':
        return this.onAdminLogin(ws, conn, m.d, m.a)
      case 'admin-action':
        return this.onAdminAction(ws, m.d, m.a)
      case 'admin-upgrade':
        return this.onAdminUpgrade(conn, m.d)
      case 'create-room':
        return this.onCreateRoom(ws, conn, m.d, m.a)
      case 'join-room':
        return this.onJoinRoom(ws, conn, m.d, m.a)
      case 'send-message':
        return this.onSendMessage(conn, m.d)
      case 'set-typing':
        return this.onSetTyping(conn, m.d)
      case 'leave-room':
        return this.onLeaveRoom(conn)
      default:
        return
    }
  }

  // ---------- events ----------
  private onJoinGlobal(ws: WebSocket, conn: Conn, d: any, a: unknown) {
    const name = cleanName(d?.name)
    if (!name) return this.ack(ws, a, { ok: false, error: 'BAD_NAME' })
    if (this.bannedUsers.has(name.toLowerCase()) || this.isBannedSocket(conn.ip)) {
      return this.ack(ws, a, { ok: false, error: 'BANNED' })
    }
    const g = this.global
    const existing = g.users.get(conn.uid)
    if (!existing && g.users.size >= MAX_GLOBAL_USERS) {
      return this.ack(ws, a, { ok: false, error: 'SERVER_BUSY' })
    }
    const admin = Boolean(d?.adminToken) && this.adminTokens.has(String(d.adminToken))
    const seat = this.seatUp(g, conn, name, admin, true)
    console.log(`[global] ${name} joined (${g.users.size})${seat.admin ? ' 👑' : ''}`)
    this.ack(ws, a, {
      ok: true,
      users: Array.from(g.users.values()).map((s) => this.publicSeat(s)),
      messages: g.messages.slice(-MAX_MESSAGES_KEPT),
    })
    if (this.frozen && !seat.admin) this.send(ws, 'mod-update', { frozen: true })
  }

  private onAdminLogin(ws: WebSocket, conn: Conn, d: any, a: unknown) {
    const user = String(d?.user ?? '').trim().toLowerCase()
    const pass = String(d?.pass ?? '').trim()
    const okUser = user === (this.env.ADMIN_USER ?? 'za3im')
    const okPass = pass === (this.env.ADMIN_PASS ?? '')
    if (!okUser || !okPass) {
      console.log(`[admin] failed attempt (${user || 'empty'})`)
      return this.ack(ws, a, { ok: false, error: 'BAD_CREDENTIALS' })
    }
    const token = genId() + genId()
    this.adminTokens.add(token)
    // crown the global seat right away
    const seat = this.global.users.get(conn.uid)
    if (seat) {
      seat.admin = true
      this.broadcastUsers(this.global)
      this.pushAndEmit(this.global, this.sys('👑 The Za3im has taken the throne'))
    }
    console.log('[admin] owner authenticated 👑')
    this.ack(ws, a, { ok: true, token })
  }

  private onAdminUpgrade(conn: Conn, d: any) {
    if (!d?.token || !this.adminTokens.has(String(d.token))) return
    const room = this.rooms.get(conn.roomCode)
    if (!room || room.code === GLOBAL_CODE) return
    const seat = room.users.get(conn.uid)
    if (seat && !seat.admin) {
      seat.admin = true
      this.broadcastUsers(room)
      this.pushAndEmit(room, this.sys('👑 The Za3im has taken the throne'))
    }
  }

  private kickMatches(victimNames: Set<string>, victimIps: Set<string>) {
    for (const room of Array.from(this.rooms.values())) {
      let changed = false
      for (const [uid, seat] of Array.from(room.users)) {
        const hit =
          victimNames.has(seat.name.toLowerCase()) ||
          (seat.ip && victimIps.has(seat.ip))
        if (hit) {
          room.users.delete(uid)
          changed = true
          if (seat.ws) {
            this.send(seat.ws, 'chat-error', { code: 'BANNED' })
            try {
              seat.ws.close(4001, 'banned')
            } catch { /* ignore */ }
          }
        }
      }
      if (changed) {
        if (room.users.size === 0 && room.code !== GLOBAL_CODE) {
          room.touchedAt = Date.now()
        } else {
          this.broadcastUsers(room)
        }
      }
    }
  }

  private announce(text: string) {
    this.pushAndEmit(this.global, this.sys(text))
  }

  private onAdminAction(ws: WebSocket, d: any, a: unknown) {
    if (!d?.token || !this.adminTokens.has(String(d.token))) {
      return this.ack(ws, a, { ok: false, error: 'ADMIN_STALE' })
    }
    const act = String(d.action ?? '')
    switch (act) {
      case 'clear-global':
        this.global.messages = []
        void this.persistGlobal()
        for (const seat of this.global.users.values()) {
          if (seat.ws) this.send(seat.ws, 'global-cleared')
        }
        console.log('[mod] global cleared by owner')
        return this.ack(ws, a, { ok: true })

      case 'delete-message': {
        const id = String(d.id ?? '')
        const idx = this.global.messages.findIndex((m) => m.id === id)
        if (idx >= 0) {
          this.global.messages.splice(idx, 1)
          void this.persistGlobal()
          for (const seat of this.global.users.values()) {
            if (seat.ws) this.send(seat.ws, 'message-deleted', { id, scope: 'global' })
          }
        }
        return this.ack(ws, a, { ok: true })
      }

      case 'ban-user': {
        const name = cleanName(d.name)
        if (!name) return this.ack(ws, a, { ok: false, error: 'BAD_NAME' })
        const key = name.toLowerCase()
        this.bannedUsers.add(key)
        const ips = new Set<string>()
        if (d.alsoIp) {
          for (const room of this.rooms.values()) {
            for (const seat of room.users.values()) {
              if (seat.name.toLowerCase() === key && seat.ip) ips.add(seat.ip)
            }
          }
          for (const ip of ips) this.bannedIPs.add(ip)
        }
        void this.persistModeration()
        console.log(`[mod] banned user "${name}"${ips.size ? ' +IP' : ''}`)
        this.kickMatches(new Set([key]), ips)
        this.announce(`🚫 ${name} has been banned by the Za3im`)
        return this.ack(ws, a, { ok: true, ips: Array.from(ips) })
      }

      case 'unban-user':
        this.bannedUsers.delete(cleanName(d.name).toLowerCase())
        void this.persistModeration()
        return this.ack(ws, a, { ok: true })

      case 'ban-ip': {
        const ip = String(d.ip ?? '').trim()
        if (!ip) return this.ack(ws, a, { ok: false, error: 'BAD_NAME' })
        this.bannedIPs.add(ip)
        void this.persistModeration()
        console.log(`[mod] banned ip ${ip}`)
        this.kickMatches(new Set(), new Set([ip]))
        this.announce('🚫 An IP has been banned by the Za3im')
        return this.ack(ws, a, { ok: true })
      }

      case 'unban-ip':
        this.bannedIPs.delete(String(d.ip ?? '').trim())
        void this.persistModeration()
        return this.ack(ws, a, { ok: true })

      case 'broadcast': {
        const text = cleanContent(d.text)
        if (!text) return this.ack(ws, a, { ok: false, error: 'BAD_NAME' })
        this.announce(`📢 ${text}`)
        return this.ack(ws, a, { ok: true })
      }

      case 'freeze-global':
        this.frozen = true
        void this.persistModeration()
        this.broadcast(this.global, 'mod-update', { frozen: true })
        console.log('[mod] global FROZEN')
        return this.ack(ws, a, { ok: true })

      case 'unfreeze-global':
        this.frozen = false
        void this.persistModeration()
        this.broadcast(this.global, 'mod-update', { frozen: false })
        return this.ack(ws, a, { ok: true })

      case 'list-bans': {
        const onlineIps: Record<string, string> = {}
        for (const seat of this.global.users.values()) {
          if (seat.ip) onlineIps[seat.name] = seat.ip
        }
        return this.ack(ws, a, {
          ok: true,
          users: Array.from(this.bannedUsers),
          ips: Array.from(this.bannedIPs),
          frozen: this.frozen,
          onlineIps,
        })
      }

      default:
        return this.ack(ws, a, { ok: false, error: 'BAD_ACTION' })
    }
  }

  private async onCreateRoom(ws: WebSocket, conn: Conn, d: any, a: unknown) {
    const name = cleanName(d?.name)
    if (!name) return this.ack(ws, a, { ok: false, error: 'BAD_NAME' })
    if (this.bannedUsers.has(name.toLowerCase()) || this.isBannedSocket(conn.ip)) {
      return this.ack(ws, a, { ok: false, error: 'BANNED' })
    }
    const code = conn.roomCode
    if (this.rooms.has(code)) {
      return this.ack(ws, a, { ok: false, error: 'ROOM_EXISTS' })
    }
    if (this.rooms.size >= MAX_ROOMS) {
      return this.ack(ws, a, { ok: false, error: 'SERVER_BUSY' })
    }
    const password = cleanPassword(d?.password)
    const room: Rm = {
      code,
      ownerUid: conn.uid,
      passwordHash: password ? await sha256(password) : null,
      messages: [],
      users: new Map(),
      touchedAt: Date.now(),
    }
    this.rooms.set(code, room)
    this.pendingCodes.delete(code)
    const admin = Boolean(d?.adminToken) && this.adminTokens.has(String(d.adminToken))
    const seat = this.seatUp(room, conn, name, admin, false)
    console.log(`[room] created ${code} by ${name}${password ? ' (locked)' : ''}`)
    this.ack(ws, a, {
      ok: true,
      code,
      token: seat.token,
      isOwner: true,
      users: Array.from(room.users.values()).map((s) => this.publicSeat(s)),
      messages: room.messages,
    })
  }

  private async onJoinRoom(ws: WebSocket, conn: Conn, d: any, a: unknown) {
    const code = String(d?.roomCode ?? '').trim().toUpperCase().slice(0, 16)
    if (!code || code === GLOBAL_CODE) return this.ack(ws, a, { ok: false, error: 'ROOM_NOT_FOUND' })
    const name = cleanName(d?.name)
    if (!name) return this.ack(ws, a, { ok: false, error: 'BAD_NAME' })
    if (this.bannedUsers.has(name.toLowerCase()) || this.isBannedSocket(conn.ip)) {
      return this.ack(ws, a, { ok: false, error: 'BANNED' })
    }
    const room = this.rooms.get(code)
    if (!room) return this.ack(ws, a, { ok: false, error: 'ROOM_NOT_FOUND' })

    const existing = room.users.get(conn.uid)
    const admin = Boolean(d?.adminToken) && this.adminTokens.has(String(d.adminToken))

    if (existing) {
      // same device re-joining — silent resume, no password needed
      const seat = this.seatUp(room, conn, name, admin, true)
      return this.ack(ws, a, {
        ok: true,
        code,
        token: seat.token,
        isOwner: room.ownerUid === conn.uid,
        users: Array.from(room.users.values()).map((s) => this.publicSeat(s)),
        messages: room.messages,
      })
    }

    if (room.users.size >= MAX_USERS_PER_ROOM) {
      return this.ack(ws, a, { ok: false, error: 'ROOM_FULL' })
    }

    if (room.passwordHash) {
      const token = String(d?.token ?? '')
      const resuming = Boolean(
        d?.silent &&
          token &&
          Array.from(room.users.values()).some((s) => s.token === token && !s.connected)
      )
      if (!resuming) {
        const password = cleanPassword(d?.password)
        if (!password) return this.ack(ws, a, { ok: false, error: 'ROOM_PASSWORD_REQUIRED' })
        const hash = await sha256(password)
        if (hash !== room.passwordHash) {
          return this.ack(ws, a, { ok: false, error: 'ROOM_WRONG_PASSWORD' })
        }
      }
    }

    const seat = this.seatUp(room, conn, name, admin, Boolean(d?.silent))
    console.log(`[room] ${code} <= ${name} (${room.users.size})`)
    this.ack(ws, a, {
      ok: true,
      code,
      token: seat.token,
      isOwner: room.ownerUid === conn.uid,
      users: Array.from(room.users.values()).map((s) => this.publicSeat(s)),
      messages: room.messages,
    })
  }

  private onSendMessage(conn: Conn, d: any) {
    const globalScope = d?.scope === 'global'
    const room = globalScope ? this.global : this.rooms.get(conn.roomCode)
    if (!room) return
    const seat = room.users.get(conn.uid)
    if (!seat || !seat.connected) {
      if (globalScope && seat?.ws) this.send(seat.ws, 'chat-error', { code: 'NOT_IN_GLOBAL' })
      return
    }
    const now = Date.now()
    const content = cleanContent(d?.content)
    if (!content) return

    if (seat.mutedUntil && now < seat.mutedUntil) {
      if (seat.ws) this.send(seat.ws, 'chat-error', { code: 'MUTED', seconds: Math.ceil((seat.mutedUntil - now) / 1000) })
      return
    }
    if (now - seat.lastSentAt < SEND_COOLDOWN_MS) return
    if (seat.lastContent === content && now - seat.lastContentAt < DUP_WINDOW_MS) {
      if (seat.ws) this.send(seat.ws, 'chat-error', { code: 'DUPLICATE' })
      return
    }
    seat.sendTimes = seat.sendTimes.filter((t) => now - t < FLOOD_WINDOW_MS)
    seat.sendTimes.push(now)
    if (seat.sendTimes.length > FLOOD_MAX_MSGS) {
      seat.mutedUntil = now + FLOOD_MUTE_MS
      seat.sendTimes = []
      if (seat.ws) this.send(seat.ws, 'chat-error', { code: 'MUTED', seconds: FLOOD_MUTE_MS / 1000 })
      return
    }
    if (globalScope && this.frozen && !seat.admin) {
      if (seat.ws) this.send(seat.ws, 'chat-error', { code: 'FROZEN' })
      return
    }
    if (this.bannedUsers.has(seat.name.toLowerCase()) || (seat.ip && this.bannedIPs.has(seat.ip))) {
      this.kickMatches(new Set([seat.name.toLowerCase()]), new Set())
      return
    }

    seat.lastSentAt = now
    seat.lastContent = content
    seat.lastContentAt = now
    seat.typingUntil = 0
    this.broadcastTyping(room)
    this.pushAndEmit(room, {
      id: genId(),
      userId: seat.uid,
      name: seat.name,
      color: seat.color,
      content,
      ts: now,
      type: 'user',
      isAdmin: seat.admin || undefined,
    })
  }

  private onSetTyping(conn: Conn, d: any) {
    const globalScope = d?.scope === 'global'
    const room = globalScope ? this.global : this.rooms.get(conn.roomCode)
    if (!room) return
    const seat = room.users.get(conn.uid)
    if (!seat || !seat.connected) return
    seat.typingUntil = d?.isTyping ? Date.now() + TYPING_TTL_MS : 0
    this.broadcastTyping(room)
  }

  private onLeaveRoom(conn: Conn) {
    const room = this.rooms.get(conn.roomCode)
    if (!room || room.code === GLOBAL_CODE) return
    this.leaveSeat(room, conn.uid, false)
  }
}
