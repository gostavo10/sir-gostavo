/* ============================================================
 * Combat Chat — unified production server
 * Serves the Next.js app AND the socket.io chat service on ONE
 * port, so it deploys to Railway / Render / Fly.io / HF Spaces
 * / any Node host as a single process.
 *
 * Room logic is a 1:1 port of mini-services/chat-service/index.ts
 * (the exact code tested in the sandbox). The only differences:
 *  - socket.io path is '/socket.io' (default) instead of '/'
 *  - port comes from the PORT env var
 *  - /healthz endpoint for platform health checks
 * ============================================================ */
'use strict'

const { createServer } = require('http')
const { createHash, randomBytes, timingSafeEqual } = require('crypto')
const next = require('next')
const { Server } = require('socket.io')

const PORT = parseInt(process.env.PORT || '3000', 10)
const HOST = process.env.HOST || '0.0.0.0'
const dev = process.env.NODE_ENV !== 'production'

// ---------- Constants (identical to sandbox chat service) ----------
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const ROOM_CODE_LENGTH = 8
const MAX_USERS_PER_ROOM = 30
const MAX_MESSAGES_KEPT = 500
const MAX_ROOMS = 300
const NAME_MAX = 20
const CONTENT_MAX = 600
const PASSWORD_MAX = 16
const SEND_COOLDOWN_MS = 350
const TYPING_TTL_MS = 5000
const FLOOD_WINDOW_MS = 10_000
const FLOOD_MAX_MSGS = 8
const FLOOD_MUTE_MS = 15_000
const DUP_WINDOW_MS = 5_000
const GRACE_MS = 60_000
// --- global chat: one open lobby for everyone, no codes, no passwords
const GLOBAL_CODE = 'GLOBAL'
const MAX_GLOBAL_USERS = 100
// --- the one and only owner of the system (change via env on the host)
const ADMIN_USER = (process.env.ADMIN_USER || 'za3im').trim().toLowerCase()
// real password is injected via the ADMIN_PASS env var on the host — never hardcode it here
const ADMIN_PASS = process.env.ADMIN_PASS || 'SET-ADMIN-PASS-ENV'
const ADMIN_MAX_ATTEMPTS = 5
const ADMIN_LOCKOUT_MS = 10 * 60_000

const NAME_COLORS = [
  '#d4af37', '#c0c0c0', '#cd7f32', '#10b981', '#a855f7',
  '#ef4444', '#ec4899', '#14b8a6', '#f97316', '#84cc16',
]

// ---------- State ----------
const rooms = new Map()
const adminTokens = new Set() // owner session tokens
const adminFails = new Map() // login attempt tracker

// The global lobby: always exists, history never wipes, joins are silent.
// A socket can be in the global lobby AND one game room at the same time.
const globalRoom = {
  code: GLOBAL_CODE,
  ownerSocketId: '',
  passwordHash: null,
  createdAt: Date.now(),
  users: new Map(),
  messages: [],
  typing: new Map(),
  graceTimers: new Map(),
}
rooms.set(GLOBAL_CODE, globalRoom)

// ---------- Helpers ----------
const genId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

function genRoomCode() {
  let code = ''
  do {
    code = ''
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]
    }
  } while (rooms.has(code))
  return code
}

const pickColor = () =>
  NAME_COLORS[Math.floor(Math.random() * NAME_COLORS.length)]

const sanitizeName = (raw) =>
  String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, NAME_MAX)

const sanitizeContent = (raw) =>
  String(raw ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
    .slice(0, CONTENT_MAX)

const sanitizePassword = (raw) =>
  String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f\s]/g, '')
    .slice(0, PASSWORD_MAX)

function pushMessage(room, msg) {
  room.messages.push(msg)
  if (room.messages.length > MAX_MESSAGES_KEPT) {
    room.messages.splice(0, room.messages.length - MAX_MESSAGES_KEPT)
  }
}

function sysMsg(content) {
  return {
    id: genId(), userId: 'system', name: 'system', color: '#9c9a92',
    content, ts: Date.now(), type: 'system',
  }
}

const newToken = () => randomBytes(16).toString('hex')

// ---------- Next.js + socket.io on one port ----------
const app = next({ dev })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }))
      return
    }
    handle(req, res)
  })

  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e5,
  })

const wireScope = (room) => (room.code === GLOBAL_CODE ? 'global' : 'room')

function emitMessage(room, msg) {
  io.to(room.code).emit('message', { ...msg, scope: wireScope(room) })
}

  function broadcastUsers(room) {
    io.to(room.code).emit('users', {
      scope: wireScope(room),
      ownerId: room.ownerSocketId,
      users: Array.from(room.users.values()),
    })
  }

  function broadcastTyping(room) {
    io.to(room.code).emit('typing', {
      scope: wireScope(room),
      names: Array.from(room.typing.keys()).map((id) => room.users.get(id)?.name ?? ''),
    })
  }

  // A returning user (tab re-open / refresh within the grace window)
  // reclaims their seat silently: same name, same color, no announcement.
  function tryResume(socket, room, token, isAdmin = false) {
    if (!token) return null
    for (const [sid, u] of room.users) {
      if (u.token !== token || u.connected) continue
      const t = room.graceTimers.get(sid)
      if (t) {
        clearTimeout(t)
        room.graceTimers.delete(sid)
      }
      room.users.delete(sid)
      u.id = socket.id
      u.connected = true
      u.isAdmin = isAdmin || u.isAdmin === true
      room.users.set(socket.id, u)
      if (room.ownerSocketId === sid) room.ownerSocketId = socket.id
      socket.data.baseColor = u.color
      socket.join(room.code)
      socket.data.user = { ...u, roomCode: room.code }
      socket.data.lastSentAt = 0
      socket.data.lastContent = ''
      socket.data.lastContentAt = 0
      socket.data.sendTimes = []
      socket.data.mutedUntil = 0
      broadcastUsers(room)
      console.log(`[room] ${room.code} <= ${u.name} (resumed seat)`)
      return {
        ok: true,
        isOwner: room.ownerSocketId === socket.id,
        users: Array.from(room.users.values()),
        messages: room.messages,
      }
    }
    return null
  }

  function clearTyping(room, userId) {
    const t = room.typing.get(userId)
    if (t) {
      clearTimeout(t)
      room.typing.delete(userId)
    }
    broadcastTyping(room)
  }

  function markTyping(room, userId) {
    const t = room.typing.get(userId)
    if (t) clearTimeout(t)
    room.typing.set(
      userId,
      setTimeout(() => clearTyping(room, userId), TYPING_TTL_MS)
    )
    broadcastTyping(room)
  }

  function joinRoom(socket, room, name, silent, isAdmin = false) {
    if (room.users.size >= MAX_USERS_PER_ROOM && !room.users.has(socket.id)) {
      return { ok: false, error: 'ROOM_FULL' }
    }

    const data = socket.data
    if (data.user?.roomCode && data.user.roomCode !== room.code) {
      const prev = rooms.get(data.user.roomCode)
      if (prev) leaveRoom(socket, prev, false)
    }

    const color = data.user?.color ?? data.baseColor ?? pickColor()
    data.baseColor = color
    const user = {
      id: socket.id,
      token: newToken(),
      name,
      color,
      connected: true,
      isAdmin: isAdmin || undefined,
    }
    room.users.set(socket.id, user)
    socket.join(room.code)
    socket.data.user = { ...user, roomCode: room.code }
    socket.data.lastSentAt = 0
    socket.data.lastContent = ''
    socket.data.lastContentAt = 0
    socket.data.sendTimes = []
    socket.data.mutedUntil = 0

    if (!silent) {
      pushMessage(room, sysMsg(`${name} joined the room 🎮`))
      emitMessage(room, room.messages[room.messages.length - 1])
    }

    broadcastUsers(room)

    return {
      ok: true,
      isOwner: room.ownerSocketId === socket.id,
      users: Array.from(room.users.values()),
      messages: room.messages,
    }
  }

  function leaveRoom(socket, room, announce = true) {
    if (room.code === GLOBAL_CODE) return // global lobby never leaves this way
    const user = room.users.get(socket.id)
    if (!user) return

    room.users.delete(socket.id)
    socket.leave(room.code)
    clearTyping(room, socket.id)

    if (announce) {
      pushMessage(room, sysMsg(`${user.name} left the room 👋`))
      emitMessage(room, room.messages[room.messages.length - 1])
    }

    if (room.users.size === 0) {
      rooms.delete(room.code)
      console.log(`[room] ${room.code} wiped (last member left)`)
      return
    }

    if (room.ownerSocketId === socket.id) {
      const nxt = room.users.values().next().value
      if (nxt) room.ownerSocketId = nxt.id
    }
    broadcastUsers(room)
  }

  function removeStaleUser(room, sid) {
    if (room.code === GLOBAL_CODE) return // handled elsewhere — never wipes
    const user = room.users.get(sid)
    if (!user || user.connected) return

    room.users.delete(sid)
    clearTyping(room, sid)
    pushMessage(room, sysMsg(`${user.name} left the room 👋`))
    emitMessage(room, room.messages[room.messages.length - 1])

    if (room.users.size === 0) {
      rooms.delete(room.code)
      console.log(`[room] ${room.code} wiped (last member left)`)
      return
    }

    if (room.ownerSocketId === sid) {
      const nxt = room.users.values().next().value
      if (nxt) room.ownerSocketId = nxt.id
    }
    broadcastUsers(room)
  }

  io.on('connection', (socket) => {
    socket.data.lastSentAt = 0
    socket.data.lastContent = ''
    socket.data.lastContentAt = 0
    socket.data.sendTimes = []
    socket.data.mutedUntil = 0

    socket.on('check-room', (payload, ack) => {
      const code = String(payload?.roomCode ?? '').trim().toUpperCase()
      if (code === GLOBAL_CODE) {
        ack?.({ ok: true, exists: false, hasPassword: false })
        return
      }
      const room = rooms.get(code)
      ack?.({
        ok: true,
        exists: Boolean(room),
        hasPassword: Boolean(room?.passwordHash),
      })
    })

    socket.on('create-room', (payload, ack) => {
      const name = sanitizeName(payload?.name)
      if (!name) {
        ack?.({ ok: false, error: 'BAD_NAME' })
        return
      }
      if (rooms.size >= MAX_ROOMS) {
        ack?.({ ok: false, error: 'SERVER_BUSY' })
        return
      }
      const password = sanitizePassword(payload?.password)
      const room = {
        code: genRoomCode(),
        ownerSocketId: socket.id,
        passwordHash: password ? sha256(password) : null,
        createdAt: Date.now(),
        users: new Map(),
        messages: [],
        typing: new Map(),
        graceTimers: new Map(),
      }
      rooms.set(room.code, room)
      const res = joinRoom(socket, room, name, false, adminTokens.has(String(payload?.adminToken ?? '')))
      console.log(
        `[room] created ${room.code} by ${name}${password ? ' (password-protected)' : ''}`
      )
      ack?.({ ...res, code: room.code, token: (res.ok && socket.data.user ? socket.data.user.token : undefined) })
    })

    socket.on('join-room', (payload, ack) => {
      const code = String(payload?.roomCode ?? '').trim().toUpperCase()
      if (code === GLOBAL_CODE) {
        ack?.({ ok: false, error: 'ROOM_NOT_FOUND' })
        return
      }
      const name = sanitizeName(payload?.name)
      if (!name) {
        ack?.({ ok: false, error: 'BAD_NAME' })
        return
      }
      const room = rooms.get(code)
      if (!room) {
        ack?.({ ok: false, error: 'ROOM_NOT_FOUND' })
        return
      }
      if (room.passwordHash) {
        const password = sanitizePassword(payload?.password)
        const resuming = payload?.silent
          ? tryResume(socket, room, String(payload?.token ?? ''), adminTokens.has(String(payload?.adminToken ?? '')))
          : null
        if (!resuming) {
          if (!password && !payload?.silent) {
            ack?.({ ok: false, error: 'ROOM_PASSWORD_REQUIRED' })
            return
          }
          if (sha256(password) !== room.passwordHash) {
            ack?.({ ok: false, error: 'ROOM_WRONG_PASSWORD' })
            return
          }
        } else {
          ack?.({ ...resuming, token: String(payload?.token ?? '') })
          return
        }
      } else if (payload?.silent) {
        const resumed = tryResume(socket, room, String(payload?.token ?? ''), adminTokens.has(String(payload?.adminToken ?? '')))
        if (resumed) {
          ack?.({ ...resumed, token: String(payload?.token ?? '') })
          return
        }
      }
      const res = joinRoom(socket, room, name, Boolean(payload?.silent), adminTokens.has(String(payload?.adminToken ?? '')))
      if (res.ok) console.log(`[room] ${code} <= ${name} (${room.users.size} online)`)
      ack?.({ ...res, token: res.ok && socket.data.user ? socket.data.user.token : undefined })
    })

    // ---- GLOBAL CHAT: one open lobby, no codes, no passwords, silent joins ----
    socket.on('join-global', (payload, ack) => {
      const data = socket.data
      const name = sanitizeName(payload?.name)
      if (!name) {
        ack?.({ ok: false, error: 'BAD_NAME' })
        return
      }
      if (globalRoom.users.size >= MAX_GLOBAL_USERS && !globalRoom.users.has(socket.id)) {
        ack?.({ ok: false, error: 'SERVER_BUSY' })
        return
      }
      // one seat per connection — a re-join replaces the old entry silently
      globalRoom.users.delete(socket.id)
      const color = data.user?.color ?? data.baseColor ?? pickColor()
      data.baseColor = color
      const user = {
        id: socket.id,
        token: newToken(),
        name,
        color,
        connected: true,
        isAdmin: adminTokens.has(String(payload?.adminToken ?? '')) || undefined,
      }
      globalRoom.users.set(socket.id, user)
      socket.join(GLOBAL_CODE)
      broadcastUsers(globalRoom)
      console.log(`[global] ${name} joined (${globalRoom.users.size} online)${user.isAdmin ? ' 👑 OWNER' : ''}`)
      ack?.({
        ok: true,
        users: Array.from(globalRoom.users.values()),
        messages: globalRoom.messages,
      })
    })

    // ---- OWNER LOGIN: one admin only, brute-force guarded ----
    socket.on('admin-login', (payload, ack) => {
      const data = socket.data
      const now = Date.now()
      const fail = adminFails.get(socket.id)
      if (fail && fail.until && now < fail.until) {
        ack?.({ ok: false, error: 'LOCKED' })
        return
      }
      const safeEq = (a, b) => {
        const ha = sha256(a)
        const hb = sha256(b)
        return ha.length === hb.length && timingSafeEqual(Buffer.from(ha), Buffer.from(hb))
      }
      const good =
        safeEq(String(payload?.user ?? '').trim().toLowerCase(), ADMIN_USER) &&
        safeEq(String(payload?.pass ?? ''), ADMIN_PASS)
      if (!good) {
        const n = (fail?.n ?? 0) + 1
        adminFails.set(socket.id, { n, until: n >= ADMIN_MAX_ATTEMPTS ? now + ADMIN_LOCKOUT_MS : 0 })
        console.log(`[admin] failed login attempt #${n}`)
        ack?.({ ok: false, error: n >= ADMIN_MAX_ATTEMPTS ? 'LOCKED' : 'BAD_CREDENTIALS' })
        return
      }
      adminFails.delete(socket.id)
      const token = newToken()
      adminTokens.add(token)

      // crown every live membership of this connection (game room + global)
      const gu = globalRoom.users.get(socket.id)
      if (gu) {
        gu.isAdmin = true
        broadcastUsers(globalRoom)
        const throne = sysMsg('👑 The Za3im has taken the throne')
        pushMessage(globalRoom, throne)
        emitMessage(globalRoom, throne)
      }
      if (data.user?.roomCode) {
        const room = rooms.get(data.user.roomCode)
        const u = room?.users.get(socket.id)
        if (room && u && room.code !== GLOBAL_CODE) {
          u.isAdmin = true
          broadcastUsers(room)
          const throne2 = sysMsg('👑 The Za3im has taken the throne')
          pushMessage(room, throne2)
          emitMessage(room, throne2)
        }
      }
      console.log('[admin] owner authenticated 👑')
      ack?.({ ok: true, token })
    })

    socket.on('send-message', (payload) => {
      const data = socket.data
      const globalScope = payload?.scope === 'global'
      const room = globalScope ? globalRoom : rooms.get(data.user?.roomCode ?? '')
      const member = globalScope ? globalRoom.users.get(socket.id) : room?.users.get(socket.id)
      if (!room || !member) return

      const now = Date.now()
      const content = sanitizeContent(payload?.content)
      if (!content) return

      if (data.mutedUntil && now < data.mutedUntil) {
        socket.emit('chat-error', {
          code: 'MUTED',
          seconds: Math.ceil((data.mutedUntil - now) / 1000),
        })
        return
      }

      if (now - (data.lastSentAt ?? 0) < SEND_COOLDOWN_MS) return

      if (data.lastContent === content && now - data.lastContentAt < DUP_WINDOW_MS) {
        socket.emit('chat-error', { code: 'DUPLICATE' })
        return
      }

      data.sendTimes = (data.sendTimes ?? []).filter((t) => now - t < FLOOD_WINDOW_MS)
      data.sendTimes.push(now)
      if (data.sendTimes.length > FLOOD_MAX_MSGS) {
        data.mutedUntil = now + FLOOD_MUTE_MS
        data.sendTimes = []
        socket.emit('chat-error', { code: 'MUTED', seconds: FLOOD_MUTE_MS / 1000 })
        console.log(`[anti-spam] ${member.name} muted ${FLOOD_MUTE_MS / 1000}s (flood)`)
        return
      }

      data.lastSentAt = now
      data.lastContent = content
      data.lastContentAt = now

      clearTyping(room, socket.id)
      const msg = {
        id: genId(),
        userId: member.id,
        name: member.name,
        color: member.color,
        content,
        ts: now,
        type: 'user',
        isAdmin: member.isAdmin || undefined,
      }
      pushMessage(room, msg)
      emitMessage(room, msg)
    })

    socket.on('set-typing', (payload) => {
      const data = socket.data
      const globalScope = payload?.scope === 'global'
      const room = globalScope ? globalRoom : rooms.get(data.user?.roomCode ?? '')
      const member = globalScope ? globalRoom.users.get(socket.id) : room?.users.get(socket.id)
      if (!room || !member) return
      if (payload?.isTyping) markTyping(room, socket.id)
      else clearTyping(room, socket.id)
    })

    socket.on('leave-room', () => {
      const data = socket.data
      if (data.user?.roomCode) {
        const room = rooms.get(data.user.roomCode)
        if (room) leaveRoom(socket, room)
        socket.data.user = undefined
      }
    })

    socket.on('disconnect', () => {
      const data = socket.data
      // Global chat: seats are free — remove immediately, the history stays.
      if (globalRoom.users.has(socket.id)) {
        const g = globalRoom.users.get(socket.id)
        clearTyping(globalRoom, socket.id)
        globalRoom.users.delete(socket.id)
        broadcastUsers(globalRoom)
        adminFails.delete(socket.id)
        if (g) console.log(`[global] ${g.name} left (${globalRoom.users.size} online)`)
      }
      if (!data.user?.roomCode) return
      const room = rooms.get(data.user.roomCode)
      const u = room?.users.get(socket.id)
      if (!room || !u) return

      u.connected = false
      u.id = ''
      clearTyping(room, socket.id)
      broadcastUsers(room)
      const t = setTimeout(() => {
        room.graceTimers.delete(socket.id)
        removeStaleUser(room, socket.id)
      }, GRACE_MS)
      room.graceTimers.set(socket.id, t)
    })

    socket.on('error', (error) => {
      console.error(`[socket] ${socket.id} error:`, error)
    })
  })

  httpServer.listen(PORT, HOST, () => {
    console.log(`[combat-chat] ready on http://${HOST}:${PORT} (dev=${dev})`)
  })

  function shutdown() {
    console.log('[combat-chat] shutting down...')
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
})
