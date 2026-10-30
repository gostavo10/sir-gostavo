'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import { toast } from 'sonner'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Columns2,
  Copy,
  Crown,
  ExternalLink,
  Gamepad2,
  Globe2,
  Loader2,
  Lock,
  LogOut,
  Maximize,
  MessageSquare,
  RefreshCw,
  Send,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Smile,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react'

// ============ Constants ============
const GAME_URL = 'https://combatonline2.com/'
const APP_TITLE = 'Match Chat — Game & Talk'
const SESSION_KEY = 'mc_session'
const NAME_KEY = 'mc_name'
const SOUND_KEY = 'mc_sound'
const LAST_ROOM_KEY = 'mc_last_room'
const ADMIN_KEY = 'mc_admin_token'
const MAX_MESSAGES = 500

const QUICK_CHATS = [
  'Attack! 🔥',
  'Cover me 🛡️',
  'Nice shot 🎯',
  'Watch out 👀',
  'GG 🏆',
  'Thanks 💛',
  'Lol 😂',
  'One more? 🔁',
]

const EMOJIS = [
  '😄', '😂', '🔥', '👍', '🎮', '💪', '🎉', '❤️',
  '😎', '🤝', '😱', '😭', '🤔', '👀', '💯', '⚽',
  '🏆', '🍀', '😅', '😡', '🫡', '🥳', '💀', '👑',
]

const ERROR_TEXT: Record<string, string> = {
  BAD_NAME: 'Enter your name first',
  ROOM_NOT_FOUND: 'Room not found — everyone may have left',
  ROOM_FULL: 'Room is full (30 max)',
  ROOM_PASSWORD_REQUIRED: 'This room is locked — enter the password',
  ROOM_WRONG_PASSWORD: 'Wrong room password',
  SERVER_BUSY: 'Server busy — try again shortly',
  DUPLICATE: 'Easy! You just sent that — repeats are blocked',
}

// ============ Types ============
interface RoomUser {
  id: string
  name: string
  color: string
  isAdmin?: boolean
}

interface ChatMessage {
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

type JoinAck =
  | { ok: true; isOwner: boolean; users: RoomUser[]; messages: ChatMessage[]; code?: string; token?: string }
  | { ok: false; error: string }

type ConnStatus = 'connecting' | 'online' | 'offline'
type ViewMode = 'split' | 'game' | 'chat'
type HomeTab = 'create' | 'join'
type ChatTab = 'room' | 'global'

type GlobalJoinAck =
  | { ok: true; users: RoomUser[]; messages: ChatMessage[] }
  | { ok: false; error: string }

type AdminLoginAck = { ok: boolean; token?: string; error?: string }

interface Session {
  code: string
  name: string
  password?: string
  token?: string // secret seat token — lets us reclaim our seat after a tab close
}

// ============ Helpers ============
function playBeep(ctxRef: { current: AudioContext | null }) {
  try {
    if (!ctxRef.current) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      ctxRef.current = new Ctor()
    }
    const ctx = ctxRef.current
    if (ctx.state === 'suspended') void ctx.resume()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    const t = ctx.currentTime
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.4)
  } catch {
    /* sound is optional */
  }
}

function notify(title: string, body: string) {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body })
    }
  } catch {
    /* notifications optional */
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      return true
    } catch {
      return false
    }
  }
}

const fmtTime = (ts: number) => {
  try {
    return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

// ============ Main Component ============
export default function ArenaChat() {
  const [screen, setScreen] = useState<'home' | 'arena'>('home')
  const [homeTab, setHomeTab] = useState<HomeTab>('create')
  const [name, setName] = useState('')
  const [nameLocked, setNameLocked] = useState(false)
  const [joinCode, setJoinCode] = useState('')
  const [joinPassword, setJoinPassword] = useState('')
  const [createPassword, setCreatePassword] = useState('')
  const [roomProtected, setRoomProtected] = useState(false)
  const [lastRoom, setLastRoom] = useState<string | null>(null)
  const [busy, setBusy] = useState<'create' | 'join' | null>(null)
  const [conn, setConn] = useState<ConnStatus>('connecting')

  const [roomCode, setRoomCode] = useState('')
  const [myId, setMyId] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [isOwner, setIsOwner] = useState(false)
  const [users, setUsers] = useState<RoomUser[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [typingNames, setTypingNames] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [viewMode, setViewMode] = useState<ViewMode>('split')
  const [soundOn, setSoundOn] = useState(false)
  const [unread, setUnread] = useState(0)
  const [showNewMsgs, setShowNewMsgs] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [inputShake, setInputShake] = useState(false)
  // ids of messages that arrived LIVE (only those get the entrance animation)
  const [liveIds, setLiveIds] = useState<Set<string>>(() => new Set())

  // ---- global lobby + owner (admin) ----
  const [chatTab, setChatTab] = useState<ChatTab>('room')
  const [globalMessages, setGlobalMessages] = useState<ChatMessage[]>([])
  const [globalUsers, setGlobalUsers] = useState<RoomUser[]>([])
  const [globalTypingNames, setGlobalTypingNames] = useState<string[]>([])
  const [globalJoined, setGlobalJoined] = useState(false)
  const [unreadGlobal, setUnreadGlobal] = useState(0)
  const [adminToken, setAdminToken] = useState<string | null>(null)
  const [adminOpen, setAdminOpen] = useState(false)
  const [adminUser, setAdminUser] = useState('')
  const [adminPass, setAdminPass] = useState('')
  const [adminBusy, setAdminBusy] = useState(false)
  const [adminError, setAdminError] = useState('')

  const socketRef = useRef<Socket | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const myIdRef = useRef<string>('')
  const sessionRef = useRef<Session | null>(null)
  const nearBottomRef = useRef(true)
  const viewModeRef = useRef<ViewMode>('split')
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isTypingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const gameWrapRef = useRef<HTMLDivElement | null>(null)
  const screenRef = useRef<'home' | 'arena'>('home')
  const chatTabRef = useRef<ChatTab>('room')
  const nameRef = useRef('')
  const adminTokenRef = useRef<string | null>(null)
  const globalJoinedRef = useRef(false)

  // ---------- keep refs in sync ----------
  useEffect(() => {
    viewModeRef.current = viewMode
  }, [viewMode])
  useEffect(() => {
    screenRef.current = screen
  }, [screen])
  useEffect(() => {
    chatTabRef.current = chatTab
  }, [chatTab])

  // switching tabs: snap to the bottom and clear that tab's badge
  useEffect(() => {
    nearBottomRef.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset per-tab state on tab switch
    setShowNewMsgs(false)
    if (chatTab === 'global') setUnreadGlobal(0)
    else setUnread(0)
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [chatTab])

  // ---------- enter arena after server ack ----------
  const applyArena = useCallback(
    (code: string, res: Extract<JoinAck, { ok: true }>, quiet: boolean) => {
      setRoomCode(code)
      setUsers(res.users)
      setMessages(res.messages)
      setIsOwner(res.isOwner)
      setOwnerId(res.isOwner ? myIdRef.current : '')
      setUnread(0)
      setUnreadGlobal(0)
      setChatTab('room')
      setShowNewMsgs(false)
      nearBottomRef.current = true
      setScreen('arena')
      screenRef.current = 'arena'
      requestAnimationFrame(() => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
      if (!quiet) toast.success(`You are in room ${code} 🎮`)
    },
    []
  )

  const saveSession = useCallback((sess: Session) => {
    sessionRef.current = sess
    try {
      // localStorage (not sessionStorage) so closing the tab and coming
      // back later still finds the room while it is alive
      localStorage.setItem(SESSION_KEY, JSON.stringify(sess))
      localStorage.setItem(LAST_ROOM_KEY, sess.code)
    } catch {
      /* ignore */
    }
  }, [])

  const clearSession = useCallback(() => {
    sessionRef.current = null
    try {
      localStorage.removeItem(SESSION_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  // ---- global lobby join: silent, no codes, no passwords ----
  const ensureGlobalJoined = useCallback((n: string) => {
    const nm = n.trim()
    const s = socketRef.current
    if (!s || !nm || globalJoinedRef.current) return
    s.emit(
      'join-global',
      { name: nm, adminToken: adminTokenRef.current ?? undefined },
      (res: GlobalJoinAck) => {
        if (res.ok) {
          globalJoinedRef.current = true
          setGlobalJoined(true)
          setGlobalUsers(res.users)
          setGlobalMessages(res.messages)
        }
      }
    )
  }, [])

  // ---------- socket ----------
  useEffect(() => {
    // Restore locked identity + saved session + invite code from link
    try {
      const savedName = localStorage.getItem(NAME_KEY)
      if (savedName) {
        nameRef.current = savedName
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot localStorage read after mount
        setName(savedName)
        setNameLocked(true)
      }
      const savedSound = localStorage.getItem(SOUND_KEY)
      if (savedSound === '1') setSoundOn(true)
      const savedAdmin = localStorage.getItem(ADMIN_KEY)
      if (savedAdmin) {
        adminTokenRef.current = savedAdmin
        setAdminToken(savedAdmin)
      }
      const last = localStorage.getItem(LAST_ROOM_KEY)
      if (last) setLastRoom(last)
      const sess = localStorage.getItem(SESSION_KEY)
      if (sess) sessionRef.current = JSON.parse(sess)
    } catch {
      /* ignore */
    }
    if (typeof window !== 'undefined') {
      const q = new URLSearchParams(window.location.search)
      const rc = (q.get('room') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
      if (rc) {
        setHomeTab('join')
        setJoinCode(rc)
        window.history.replaceState(null, '', window.location.pathname)
      }
    }

    // Connection target depends on where the app is served:
    // - z.ai sandbox: the Caddy gateway routes socket traffic to the chat
    //   service (port 3003) using the XTransformPort query marker.
    // - external hosting: one unified server (server.js) serves BOTH the
    //   Next.js app and socket.io on the same origin, default path.
    const inSandbox =
      typeof window !== 'undefined' &&
      (window.location.hostname.endsWith('.space-z.ai') ||
        window.location.port === '81')

    const socketOpts = {
      transports: ['websocket', 'polling'] as ('websocket' | 'polling')[],
      forceNew: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 4000,
      timeout: 10000,
    } as const

    const s = inSandbox
      ? io('/?XTransformPort=3003', socketOpts)
      : io(window.location.origin, { ...socketOpts, path: '/socket.io' })
    socketRef.current = s

    s.on('connect', () => {
      myIdRef.current = s.id ?? ''
      setMyId(s.id ?? '')
      setConn('online')

      // Silent rejoin (page refresh, tab re-open or dropped connection)
      const sess = sessionRef.current
      if (sess) {
        s.emit(
          'join-room',
          {
            roomCode: sess.code,
            name: sess.name,
            password: sess.password,
            token: sess.token,
            adminToken: adminTokenRef.current ?? undefined,
            silent: true,
          },
          (res: JoinAck) => {
            if (res.ok) {
              applyArena(sess.code, res, true)
            } else {
              clearSession()
              if (screenRef.current === 'arena') {
                toast.error(ERROR_TEXT[res.error] ?? 'Room is gone')
                setScreen('home')
                screenRef.current = 'home'
              }
            }
            // always (re)enter the global lobby — it survives room changes
            ensureGlobalJoined(nameRef.current)
          }
        )
      } else {
        ensureGlobalJoined(nameRef.current)
      }
    })

    s.on('disconnect', () => {
      globalJoinedRef.current = false
      setGlobalJoined(false)
      setConn('offline')
    })
    s.on('connect_error', () => setConn('offline'))

    s.on('message', (m: ChatMessage) => {
      const scope: ChatTab = m.scope === 'global' ? 'global' : 'room'
      setLiveIds((prev) => {
        if (prev.has(m.id)) return prev
        const next = new Set(prev)
        next.add(m.id)
        // keep the set bounded
        if (next.size > 600) {
          const arr = Array.from(next)
          return new Set(arr.slice(arr.length - 400))
        }
        return next
      })
      const append = (prev: ChatMessage[]) =>
        prev.length >= MAX_MESSAGES ? [...prev.slice(-(MAX_MESSAGES - 1)), m] : [...prev, m]
      if (scope === 'global') setGlobalMessages(append)
      else setMessages(append)

      const mine = m.userId === myIdRef.current
      if (m.type === 'user' && !mine) {
        const chatVisible = viewModeRef.current !== 'game' && document.hasFocus()
        const activeVisible =
          chatVisible && chatTabRef.current === scope && nearBottomRef.current
        if (!activeVisible) {
          if (scope === 'global') setUnreadGlobal((u) => u + 1)
          else setUnread((u) => u + 1)
          if (chatVisible && chatTabRef.current === scope) setShowNewMsgs(true)
        }
        if (!document.hasFocus()) {
          try {
            if (localStorage.getItem(SOUND_KEY) === '1') playBeep(audioCtxRef)
          } catch {
            /* ignore */
          }
          notify(`${m.name} says:`, m.content.slice(0, 80))
        }
      }
    })

    s.on('users', (p: { scope?: string; ownerId: string; users: RoomUser[] }) => {
      if (p.scope === 'global') {
        setGlobalUsers(p.users)
        return
      }
      setUsers(p.users)
      setOwnerId(p.ownerId)
      setIsOwner(p.ownerId === myIdRef.current)
    })

    s.on('typing', (p: { scope?: string; names: string[] }) => {
      const names = (p.names ?? []).filter((n) => n && n !== '')
      if (p.scope === 'global') setGlobalTypingNames(names)
      else setTypingNames(names)
    })

    // anti-spam feedback from the server (muted / duplicate)
    s.on('chat-error', (p: { code?: string; seconds?: number }) => {
      if (p?.code === 'MUTED') {
        toast.error(
          `Slow down! You are muted for ${p.seconds ?? 15}s — too many messages`
        )
      } else {
        toast.error(ERROR_TEXT[p?.code ?? ''] ?? 'Message not sent')
      }
      setInputShake(true)
    })

    return () => {
      s.disconnect()
      socketRef.current = null
    }
  }, [applyArena, clearSession, ensureGlobalJoined])

  // ---------- unread title ----------
  useEffect(() => {
    const total = unread + unreadGlobal
    document.title = total > 0 ? `(${total}) ${APP_TITLE}` : APP_TITLE
  }, [unread, unreadGlobal])

  useEffect(() => {
    const onFocus = () => {
      if (document.hasFocus() && viewModeRef.current !== 'game') {
        if (chatTabRef.current === 'global') setUnreadGlobal(0)
        else setUnread(0)
      }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // leaving the game-only view clears the active tab's unread counter
  const changeViewMode = (mode: ViewMode) => {
    setViewMode(mode)
    if (mode !== 'game' && document.hasFocus()) {
      if (chatTabRef.current === 'global') setUnreadGlobal(0)
      else setUnread(0)
    }
  }

  // ---------- sending ----------
  const sendContent = useCallback((raw: string, scope: ChatTab = 'room') => {
    const content = raw.trim()
    const s = socketRef.current
    if (!content || !s) return
    s.emit('send-message', { content, scope })
    setInput('')
    s.emit('set-typing', { isTyping: false, scope })
    isTypingRef.current = false
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current)
      typingTimerRef.current = null
    }
  }, [])

  const onInputChange = (v: string) => {
    setInput(v)
    const s = socketRef.current
    if (!s) return
    if (v.trim() && !isTypingRef.current) {
      isTypingRef.current = true
      s.emit('set-typing', { isTyping: true, scope: chatTabRef.current })
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    if (v.trim()) {
      typingTimerRef.current = setTimeout(() => {
        isTypingRef.current = false
        s.emit('set-typing', { isTyping: false, scope: chatTabRef.current })
      }, 1800)
    } else {
      isTypingRef.current = false
      s.emit('set-typing', { isTyping: false, scope: chatTabRef.current })
    }
  }

  // ---------- create / join / leave ----------
  // The name is locked to this device forever once chosen
  const persistIdentity = (n: string) => {
    try {
      if (!localStorage.getItem(NAME_KEY)) {
        localStorage.setItem(NAME_KEY, n)
      }
    } catch {
      /* ignore */
    }
  }

  const createRoom = useCallback(() => {
    const n = name.trim()
    if (!n) {
      toast.error(ERROR_TEXT.BAD_NAME)
      return
    }
    setBusy('create')
    const pw = createPassword.trim()
    socketRef.current?.emit(
      'create-room',
      { name: n, password: pw || undefined, adminToken: adminTokenRef.current ?? undefined },
      (res: JoinAck) => {
        setBusy(null)
        if (!res.ok) {
          toast.error(ERROR_TEXT[res.error] ?? 'Something went wrong, try again')
          return
        }
        if (res.code) {
          const sess: Session = { code: res.code, name: n, password: pw || undefined, token: res.token }
          saveSession(sess)
          persistIdentity(n)
          setNameLocked(true)
          nameRef.current = n
          ensureGlobalJoined(n)
          applyArena(res.code, res, false)
        }
      }
    )
  }, [name, createPassword, applyArena, saveSession, ensureGlobalJoined])

  const joinRoom = useCallback(
    (codeOverride?: string) => {
      const n = name.trim()
      const code = (codeOverride ?? joinCode).trim().toUpperCase()
      if (!n) {
        toast.error(ERROR_TEXT.BAD_NAME)
        return
      }
      if (code.length < 4) {
        toast.error('Enter the full room code')
        return
      }
      setBusy('join')
      socketRef.current?.emit(
        'join-room',
        {
          roomCode: code,
          name: n,
          password: joinPassword.trim() || undefined,
          adminToken: adminTokenRef.current ?? undefined,
        },
        (res: JoinAck) => {
          setBusy(null)
          if (res.ok) {
            const sess: Session = {
              code,
              name: n,
              password: joinPassword.trim() || undefined,
              token: res.token,
            }
            saveSession(sess)
            persistIdentity(n)
            setNameLocked(true)
            nameRef.current = n
            ensureGlobalJoined(n)
            applyArena(code, res, false)
          } else {
            toast.error(ERROR_TEXT[res.error] ?? 'Something went wrong, try again')
          }
        }
      )
    },
    [name, joinCode, joinPassword, applyArena, saveSession, ensureGlobalJoined]
  )

  const leaveRoom = useCallback(() => {
    socketRef.current?.emit('leave-room')
    clearSession()
    // stay in the arena — the global lobby keeps running 🌍
    setRoomCode('')
    setUsers([])
    setMessages([])
    setTypingNames([])
    setUnread(0)
    setOwnerId('')
    setIsOwner(false)
    setChatTab('global')
    setViewMode('split')
    setJoinPassword('')
    document.title = APP_TITLE
    toast('You left the room — global chat is still open 🌍')
    try {
      setLastRoom(localStorage.getItem(LAST_ROOM_KEY))
    } catch {
      /* ignore */
    }
  }, [clearSession])

  // ---------- invite / share ----------
  const inviteText = useCallback(() => {
    const url = `${window.location.origin}${window.location.pathname}?room=${roomCode}`
    return `Join my Match Chat room 🎮💬\nRoom code: ${roomCode}\nLink: ${url}`
  }, [roomCode])

  const copyInvite = useCallback(async () => {
    if (!roomCode) return
    const ok = await copyText(inviteText())
    if (ok) toast.success('Invite copied — send it to your friends 📋')
    else toast.error(`Copy the code manually: ${roomCode}`)
  }, [roomCode, inviteText])

  const shareInvite = useCallback(async () => {
    if (!roomCode) return
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: 'Match Chat 🎮', text: inviteText() })
        return
      }
    } catch {
      return // user aborted the share sheet
    }
    await copyInvite()
  }, [roomCode, inviteText, copyInvite])

  const toggleSound = useCallback(() => {
    setSoundOn((prev) => {
      const next = !prev
      try {
        localStorage.setItem(SOUND_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
        try {
          void Notification.requestPermission()
        } catch {
          /* ignore */
        }
      }
      if (next) playBeep(audioCtxRef)
      return next
    })
  }, [])

  // ---- enter the global lobby straight from home (no room needed) ----
  const enterGlobal = () => {
    const n = name.trim()
    if (!n) {
      toast.error(ERROR_TEXT.BAD_NAME)
      return
    }
    persistIdentity(n)
    setNameLocked(true)
    nameRef.current = n
    setChatTab('global')
    setUnreadGlobal(0)
    setScreen('arena')
    screenRef.current = 'arena'
    ensureGlobalJoined(n)
  }

  // ---- owner (admin) login — the one and only Za3im ----
  const submitAdminLogin = () => {
    const u = adminUser.trim()
    const p = adminPass
    if (!u || !p) {
      setAdminError('Enter the owner username and password')
      return
    }
    setAdminBusy(true)
    setAdminError('')
    socketRef.current?.emit('admin-login', { user: u, pass: p }, (res: AdminLoginAck) => {
      setAdminBusy(false)
      if (res.ok && res.token) {
        adminTokenRef.current = res.token
        try {
          localStorage.setItem(ADMIN_KEY, res.token)
        } catch {
          /* ignore */
        }
        setAdminToken(res.token)
        setAdminPass('')
        setAdminOpen(false)
        toast.success('Welcome back, Za3im 👑 The crown is yours')
      } else {
        setAdminError(
          res.error === 'LOCKED'
            ? 'Too many attempts — locked for 10 minutes'
            : 'Wrong credentials — owner only'
        )
      }
    })
  }

  const scrollBottom = useCallback((smooth = true) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    nearBottomRef.current = true
    setShowNewMsgs(false)
    if (chatTabRef.current === 'global') setUnreadGlobal(0)
    else setUnread(0)
  }, [])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 90
    nearBottomRef.current = near
    if (near) {
      setShowNewMsgs(false)
      if (document.hasFocus() && viewModeRef.current !== 'game') {
        if (chatTabRef.current === 'global') setUnreadGlobal(0)
        else setUnread(0)
      }
    }
  }

  const goFullscreen = () => {
    const el = gameWrapRef.current
    if (!el) return
    try {
      if (document.fullscreenElement) void document.exitFullscreen()
      else void el.requestFullscreen()
    } catch {
      toast.error('Fullscreen is not available here')
    }
  }

  // ---------- detect password-protected room while typing the code ----------
  useEffect(() => {
    const code = joinCode.trim().toUpperCase()
    if (code.length < 6) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset hint when code is incomplete
      setRoomProtected(false)
      return
    }
    const t = setTimeout(() => {
      socketRef.current?.emit(
        'check-room',
        { roomCode: code },
        (res: { ok: boolean; exists?: boolean; hasPassword?: boolean }) => {
          if (res.ok) setRoomProtected(Boolean(res.hasPassword))
        }
      )
    }, 400)
    return () => clearTimeout(t)
  }, [joinCode])

  // ============================================================
  // Owner (admin) login overlay — one Za3im only
  // ============================================================
  const adminOverlay = adminOpen ? (
    <div
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 lux-glow"
      onClick={() => !adminBusy && setAdminOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Owner login"
    >
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 380, damping: 28 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm lux-panel rounded-2xl p-6 space-y-5"
      >
        <div className="text-center space-y-3">
          <div className="relative mx-auto w-16 h-16">
            <div className="absolute inset-1 rounded-2xl bg-gradient-to-br from-[#f3d27a] via-[#d4af37] to-[#a87f1f] opacity-30 blur-lg" />
            <div className="relative w-16 h-16 rounded-2xl border border-[#d4af37]/45 bg-[#101014] flex items-center justify-center gold-pulse">
              <Crown className="w-8 h-8 text-[#f3d27a] crown-live fill-amber-400" />
            </div>
          </div>
          <div>
            <h2 className="font-display text-2xl font-bold gold-text tracking-wide">Owner Access</h2>
            <p className="mt-1 text-xs text-[#8d8878]">
              For the one and only Za3im — crown of the system 👑
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="admin-user" className="text-xs font-semibold uppercase tracking-wider text-[#a8a294]">
              Owner username
            </label>
            <Input
              id="admin-user"
              value={adminUser}
              onChange={(e) => setAdminUser(e.target.value)}
              placeholder="za3im"
              autoCapitalize="none"
              autoComplete="off"
              dir="ltr"
              className="h-11 bg-[#141419] border-[#d4af37]/20 focus-visible:ring-[#d4af37]/40 focus-visible:border-[#d4af37]/50"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="admin-pass" className="text-xs font-semibold uppercase tracking-wider text-[#a8a294]">
              Secret password
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6d6960] pointer-events-none" />
              <Input
                id="admin-pass"
                type="password"
                value={adminPass}
                onChange={(e) => setAdminPass(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitAdminLogin()
                }}
                placeholder="••••••••"
                dir="ltr"
                className="h-11 pl-9 bg-[#141419] border-[#d4af37]/20 focus-visible:ring-[#d4af37]/40 focus-visible:border-[#d4af37]/50"
              />
            </div>
          </div>
          {adminError && (
            <p className="text-xs text-red-400 flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" /> {adminError}
            </p>
          )}
          <Button
            onClick={submitAdminLogin}
            disabled={adminBusy || !adminUser.trim() || !adminPass}
            className="gold-btn w-full h-11 font-bold rounded-xl border border-[#f3d27a]/40"
          >
            {adminBusy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Checking...
              </>
            ) : (
              'Claim the Throne 👑'
            )}
          </Button>
          <button
            type="button"
            onClick={() => !adminBusy && setAdminOpen(false)}
            className="w-full text-center text-xs text-[#6d6960] hover:text-[#a8a294] transition-colors"
          >
            Not now
          </button>
        </div>
      </motion.div>
    </div>
  ) : null

  // ============================================================
  // Home — create or join a room
  // ============================================================
  if (screen === 'home') {
    return (
      <div className="min-h-screen lux-glow bg-[#0a0a0c] text-[#efeae0]">
        <main className="flex items-center justify-center p-4 py-10">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="w-full max-w-md space-y-6"
          >
            {/* Hero */}
            <div className="text-center space-y-4">
              <div className="relative mx-auto w-20 h-20">
                <div className="absolute inset-2 rounded-3xl bg-gradient-to-br from-[#f3d27a] via-[#d4af37] to-[#a87f1f] opacity-25 blur-xl" />
                <div className="relative w-20 h-20 rounded-3xl border border-[#d4af37]/40 bg-[#101014] flex items-center justify-center gold-pulse">
                  <Gamepad2 className="w-9 h-9 text-[#d4af37]" strokeWidth={1.6} />
                </div>
              </div>
              <div>
                <h1 className="font-display text-[2.6rem] leading-tight font-bold tracking-wide gold-text">
                  Match Chat
                </h1>
                <p className="mt-2 text-sm text-[#a8a294] leading-relaxed">
                  Play <span className="text-[#e8e2d4] font-semibold">Combat Online 2</span> and talk
                  with your squad — same page, zero tab-switching.
                </p>
              </div>
            </div>

            {/* Card */}
            <div className="lux-panel rounded-2xl p-6 space-y-5">
              {/* Identity — chosen once, then locked forever */}
              {nameLocked ? (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="flex items-center gap-3 rounded-xl border border-[#d4af37]/25 bg-[#d4af37]/[0.06] p-3"
                >
                  <span className="w-11 h-11 rounded-full gold-btn flex items-center justify-center text-lg font-black shrink-0 border border-[#f3d27a]/50">
                    {name.trim().charAt(0).toUpperCase() || '?'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-sm font-bold text-[#e8e2d4]">
                      {adminToken && (
                        <Crown className="w-3.5 h-3.5 crown-live fill-amber-300 text-[#d4af37] shrink-0" />
                      )}
                      <span className={cn('truncate', adminToken && 'admin-name')}>{name}</span>
                      <Lock className="w-3.5 h-3.5 text-[#d4af37] shrink-0" />
                    </p>
                    <p className="text-[11px] text-[#8d8878]">
                      Name locked to this device — can’t be changed
                    </p>
                  </div>
                  <ShieldCheck className="w-5 h-5 text-[#d4af37]/70 shrink-0" />
                </motion.div>
              ) : (
                <div className="space-y-1.5">
                  <label htmlFor="player-name" className="text-xs font-semibold uppercase tracking-wider text-[#a8a294]">
                    Choose your name <span className="normal-case text-[#6d6960]">(picked once)</span>
                  </label>
                  <Input
                    id="player-name"
                    value={name}
                    onChange={(e) => setName(e.target.value.slice(0, 20))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && homeTab === 'create') createRoom()
                      if (e.key === 'Enter' && homeTab === 'join' && joinCode) joinRoom()
                    }}
                    placeholder="e.g. The Boss"
                    maxLength={20}
                    dir="auto"
                    className="h-11 bg-[#141419] border-[#d4af37]/20 text-base placeholder:text-[#5d594e] focus-visible:ring-[#d4af37]/40 focus-visible:border-[#d4af37]/50"
                  />
                  <p className="text-[11px] text-[#6d6960] flex items-center gap-1">
                    <Lock className="w-3 h-3 text-[#d4af37]/60" />
                    Pick carefully — this name becomes permanent on this device
                  </p>
                </div>
              )}

              {/* Tabs */}
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-black/40 p-1 border border-white/5" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={homeTab === 'create'}
                  onClick={() => setHomeTab('create')}
                  className={cn(
                    'h-9 rounded-lg text-sm font-semibold transition-colors',
                    homeTab === 'create'
                      ? 'bg-gradient-to-b from-[#d4af37]/25 to-[#d4af37]/10 gold-text border border-[#d4af37]/35'
                      : 'text-[#8d8878] hover:text-[#c9c3b4]'
                  )}
                >
                  Create a room
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={homeTab === 'join'}
                  onClick={() => setHomeTab('join')}
                  className={cn(
                    'h-9 rounded-lg text-sm font-semibold transition-colors',
                    homeTab === 'join'
                      ? 'bg-gradient-to-b from-[#d4af37]/25 to-[#d4af37]/10 gold-text border border-[#d4af37]/35'
                      : 'text-[#8d8878] hover:text-[#c9c3b4]'
                  )}
                >
                  Join with code
                </button>
              </div>

              {homeTab === 'create' ? (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label htmlFor="create-password" className="text-xs font-semibold uppercase tracking-wider text-[#a8a294]">
                      Room password <span className="normal-case text-[#6d6960]">(optional)</span>
                    </label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6d6960] pointer-events-none" />
                      <Input
                        id="create-password"
                        type="password"
                        value={createPassword}
                        onChange={(e) => setCreatePassword(e.target.value.replace(/\s/g, '').slice(0, 16))}
                        placeholder="Only friends with the password can join"
                        maxLength={16}
                        dir="ltr"
                        className="h-11 pl-9 bg-[#141419] border-[#d4af37]/20 placeholder:text-[#5d594e] focus-visible:ring-[#d4af37]/40 focus-visible:border-[#d4af37]/50"
                      />
                    </div>
                  </div>
                  <Button
                    onClick={createRoom}
                    disabled={busy !== null || conn !== 'online' || !name.trim()}
                    className="gold-btn w-full h-12 text-base font-bold rounded-xl border border-[#f3d27a]/40"
                  >
                    {busy === 'create' ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" /> Creating room...
                      </>
                    ) : conn !== 'online' ? (
                      'Connecting to server...'
                    ) : (
                      'Create Room 🎮'
                    )}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label htmlFor="join-code" className="text-xs font-semibold uppercase tracking-wider text-[#a8a294]">
                      Room code
                    </label>
                    <Input
                      id="join-code"
                      value={joinCode}
                      onChange={(e) =>
                        setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') joinRoom()
                      }}
                      placeholder="e.g. K7X2QM4P"
                      maxLength={8}
                      className="h-12 text-center text-xl font-bold tracking-[0.3em] bg-[#141419] border-[#d4af37]/20 placeholder:text-[#5d594e] placeholder:tracking-normal placeholder:text-base focus-visible:ring-[#d4af37]/40 focus-visible:border-[#d4af37]/50"
                    />
                    {roomProtected && (
                      <p className="text-xs text-[#d4af37] flex items-center gap-1 pt-0.5">
                        <Lock className="w-3 h-3" /> This room is protected — password required
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="join-password" className="text-xs font-semibold uppercase tracking-wider text-[#a8a294]">
                      Room password <span className="normal-case text-[#6d6960]">(if locked)</span>
                    </label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6d6960] pointer-events-none" />
                      <Input
                        id="join-password"
                        type="password"
                        value={joinPassword}
                        onChange={(e) => setJoinPassword(e.target.value.replace(/\s/g, '').slice(0, 16))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') joinRoom()
                        }}
                        placeholder="Leave empty for open rooms"
                        maxLength={16}
                        dir="ltr"
                        className="h-11 pl-9 bg-[#141419] border-[#d4af37]/20 placeholder:text-[#5d594e] focus-visible:ring-[#d4af37]/40 focus-visible:border-[#d4af37]/50"
                      />
                    </div>
                  </div>
                  <Button
                    onClick={() => joinRoom()}
                    disabled={busy !== null || conn !== 'online' || !name.trim() || joinCode.length < 4}
                    className="gold-btn w-full h-12 text-base font-bold rounded-xl border border-[#f3d27a]/40"
                  >
                    {busy === 'join' ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" /> Joining...
                      </>
                    ) : (
                      'Join Room 🚪'
                    )}
                  </Button>
                </div>
              )}

              {/* Global lobby — everyone in one place, no room needed */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={enterGlobal}
                  disabled={conn !== 'online' || !name.trim()}
                  className="w-full flex items-center justify-center gap-2 h-12 rounded-xl border border-[#d4af37]/30 bg-[#d4af37]/[0.06] text-sm font-bold gold-text hover:bg-[#d4af37]/15 transition-colors disabled:opacity-40"
                >
                  <Globe2 className="w-4 h-4" />
                  Global Chat — everyone in one place 🌍
                </button>
                <p className="text-[11px] text-[#6d6960] text-center">
                  No room, no code — the open lobby for everybody
                </p>
              </div>

              {/* Rejoin last room */}
              {lastRoom && (
                <button
                  type="button"
                  onClick={() => joinRoom(lastRoom)}
                  disabled={busy !== null || !name.trim()}
                  className="w-full flex items-center justify-center gap-2 h-10 rounded-xl border border-[#d4af37]/20 bg-transparent text-sm font-semibold text-[#a8a294] hover:text-[#e8e2d4] hover:border-[#d4af37]/45 transition-colors disabled:opacity-40"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Rejoin last room — <span className="tracking-widest text-[#d4af37]">{lastRoom}</span>
                </button>
              )}

              {/* Connection status */}
              <div className="flex items-center justify-center gap-2 text-xs text-[#6d6960]">
                <span
                  className={cn(
                    'w-2 h-2 rounded-full',
                    conn === 'online' && 'bg-[#d4af37] animate-pulse',
                    conn === 'connecting' && 'bg-[#8d8878]',
                    conn === 'offline' && 'bg-red-400'
                  )}
                />
                {conn === 'online'
                  ? 'Connected to server'
                  : conn === 'connecting'
                    ? 'Connecting...'
                    : 'Weak connection — retrying'}
              </div>
            </div>

            {/* Footer hints */}
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-[#6d6960]">
              <span className="flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5 text-[#d4af37]/70" /> Protected rooms</span>
              <span className="flex items-center gap-1"><Lock className="w-3.5 h-3.5 text-[#d4af37]/70" /> Locked identity</span>
              <span className="flex items-center gap-1"><MessageSquare className="w-3.5 h-3.5 text-[#d4af37]/70" /> History stays while the room lives</span>
              {!adminToken ? (
                <button
                  type="button"
                  onClick={() => setAdminOpen(true)}
                  className="flex items-center gap-1 hover:text-[#d4af37] transition-colors"
                >
                  <Crown className="w-3.5 h-3.5 text-[#d4af37]/70" /> Owner login
                </button>
              ) : (
                <span className="flex items-center gap-1 text-[#d4af37]">
                  <Crown className="w-3.5 h-3.5 crown-live fill-amber-300" /> Owner signed in
                </span>
              )}
            </div>
          </motion.div>
        </main>
        {adminOverlay}
      </div>
    )
  }

  // ============================================================
  // Arena — game + chat side by side
  // ============================================================
  // everything in the chat panel follows the active tab (global vs room)
  const roomCtaMode = chatTab === 'room' && !roomCode
  const viewingGlobal = chatTab === 'global' || !roomCode
  const listUsers = viewingGlobal ? globalUsers : users
  const onlineCount = listUsers.length
  const activeTypingNames = viewingGlobal ? globalTypingNames : typingNames
  const activeMessages = viewingGlobal ? globalMessages : messages
  const activeUnread = viewingGlobal ? unreadGlobal : unread

  const AvatarCircle = ({ user, size = 'sm' }: { user: RoomUser; size?: 'sm' | 'md' }) => (
    <span
      className={cn(
        'rounded-full flex items-center justify-center font-bold shrink-0 ring-1 ring-[#d4af37]/35',
        size === 'md' ? 'w-9 h-9 text-sm' : 'w-7 h-7 text-[11px]'
      )}
      style={{ backgroundColor: `${user.color}26`, color: user.color }}
      aria-hidden="true"
    >
      {user.name.charAt(0).toUpperCase()}
    </span>
  )

  return (
    <div className="h-screen flex flex-col bg-[#0a0a0c] text-[#efeae0] overflow-hidden">
      {/* Header */}
      <header className="shrink-0 h-14 border-b border-[#d4af37]/15 bg-[#0c0c0f]/95 backdrop-blur flex items-center gap-2 px-3 md:px-4">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg border border-[#d4af37]/40 bg-[#101014] flex items-center justify-center shrink-0">
            <Gamepad2 className="w-4 h-4 text-[#d4af37]" strokeWidth={1.8} />
          </div>
          <div className="min-w-0 hidden sm:block">
            <p className="font-display text-sm font-bold leading-tight gold-text truncate">Match Chat</p>
            <p className="text-[10px] text-[#6d6960] leading-tight">Combat Online 2</p>
          </div>
        </div>

        {/* Room code + copy invite (rooms only) */}
        {roomCode && (
          <button
            type="button"
            onClick={copyInvite}
            title="Copy invite link"
            className="flex items-center gap-1.5 rounded-lg border border-[#d4af37]/35 bg-[#d4af37]/10 px-2.5 py-1.5 text-xs font-bold gold-text hover:bg-[#d4af37]/20 transition-colors shrink-0"
          >
            <Copy className="w-3.5 h-3.5" />
            <span className="tracking-widest">{roomCode}</span>
          </button>
        )}

        {/* Share */}
        {roomCode && (
          <button
            type="button"
            onClick={shareInvite}
            title="Share invite"
            className="h-8 w-8 rounded-lg border border-[#d4af37]/25 bg-[#141419] text-[#a8a294] hover:text-[#d4af37] hover:border-[#d4af37]/50 flex items-center justify-center transition-colors shrink-0"
          >
            <Share2 className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Members */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#141419] px-2.5 py-1.5 text-xs font-semibold text-[#c9c3b4] hover:border-[#d4af37]/40 transition-colors"
            >
              <Users className="w-3.5 h-3.5" />
              {onlineCount}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={8} className="w-64 p-2 bg-[#121216] border-[#d4af37]/25">
            <p className="text-xs font-bold text-[#8d8878] px-2 pb-2 uppercase tracking-wider">
              {viewingGlobal
                ? `In global chat (${onlineCount})`
                : `In the room (${onlineCount})`}
            </p>
            <div className="max-h-64 overflow-y-auto chat-scroll space-y-0.5">
              {listUsers.map((u) => (
                <div key={u.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/5">
                  <AvatarCircle user={u} size="md" />
                  {u.isAdmin && (
                    <Crown className="w-4 h-4 crown-live fill-amber-300 text-[#d4af37] shrink-0" />
                  )}
                  <span className={cn('text-sm truncate flex-1', u.isAdmin && 'admin-name')}>
                    {u.name}
                  </span>
                  {u.id === myId && <span className="text-[10px] text-[#6d6960]">(you)</span>}
                  {!u.isAdmin && u.id === ownerId && (
                    <Crown className="w-4 h-4 text-[#d4af37] shrink-0" />
                  )}
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <div className="flex-1" />

        {/* Owner */}
        <button
          type="button"
          onClick={() => setAdminOpen(true)}
          title={adminToken ? 'Owner of the system 👑' : 'Owner login'}
          className={cn(
            'h-9 w-9 rounded-lg flex items-center justify-center border transition-colors shrink-0',
            adminToken
              ? 'border-[#d4af37]/50 bg-[#d4af37]/15'
              : 'border-white/10 bg-[#141419] text-[#6d6960] hover:text-[#d4af37] hover:border-[#d4af37]/40'
          )}
        >
          <Crown
            className={cn(
              'w-4 h-4',
              adminToken && 'crown-live fill-amber-300 text-[#d4af37]'
            )}
          />
        </button>

        {/* View modes */}
        <div
          className="flex items-center gap-1 rounded-lg bg-black/40 p-1 border border-white/10"
          role="tablist"
          aria-label="View mode"
        >
          {(
            [
              ['split', 'Split view', <Columns2 key="i" className="w-4 h-4" />],
              ['game', 'Game only', <Gamepad2 key="i" className="w-4 h-4" />],
              ['chat', 'Chat only', <MessageSquare key="i" className="w-4 h-4" />],
            ] as const
          ).map(([mode, title, icon]) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={viewMode === mode}
              title={title}
              onClick={() => changeViewMode(mode)}
              className={cn(
                'h-8 w-9 rounded-md flex items-center justify-center transition-colors relative',
                viewMode === mode
                  ? 'bg-[#d4af37]/20 text-[#d4af37]'
                  : 'text-[#6d6960] hover:text-[#c9c3b4]'
              )}
            >
              {icon}
              {mode === 'game' && unread > 0 && viewMode === 'game' && (
                <span className="absolute -top-1 -left-1 min-w-[14px] h-[14px] rounded-full bg-[#d4af37] text-black text-[9px] font-bold flex items-center justify-center px-0.5">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Sound */}
        <button
          type="button"
          onClick={toggleSound}
          title={soundOn ? 'Sound on — click to mute' : 'Sound off — click to enable'}
          className={cn(
            'h-9 w-9 rounded-lg flex items-center justify-center border transition-colors shrink-0',
            soundOn
              ? 'border-[#d4af37]/40 bg-[#d4af37]/10 text-[#d4af37]'
              : 'border-white/10 bg-[#141419] text-[#6d6960] hover:text-[#c9c3b4]'
          )}
        >
          {soundOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
        </button>

        {/* Leave */}
        {roomCode && (
          <button
            type="button"
            onClick={leaveRoom}
            title="Leave the room"
            className="h-9 w-9 rounded-lg flex items-center justify-center border border-red-500/25 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors shrink-0"
          >
            <LogOut className="w-4 h-4" />
          </button>
        )}
      </header>

      {/* Body: game + chat */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        {/* Game panel */}
        <div
          ref={gameWrapRef}
          className={cn(
            'relative min-h-0 flex-1 basis-[45%] md:basis-auto bg-black',
            viewMode === 'chat' && 'hidden'
          )}
        >
          <iframe
            src={GAME_URL}
            title="Combat Online 2"
            className="absolute inset-0 w-full h-full"
            allow="fullscreen; autoplay; gamepad; pointer-lock"
            allowFullScreen
          />
          <div className="absolute top-2 left-2 flex items-center gap-1.5 z-10">
            <button
              type="button"
              onClick={goFullscreen}
              title="Fullscreen"
              className="h-8 w-8 rounded-lg bg-black/70 border border-[#d4af37]/30 text-[#e8e2d4] hover:text-[#d4af37] hover:bg-black/90 flex items-center justify-center backdrop-blur"
            >
              <Maximize className="w-4 h-4" />
            </button>
            <a
              href={GAME_URL}
              target="_blank"
              rel="noopener noreferrer"
              title="Open game in a new tab"
              className="h-8 w-8 rounded-lg bg-black/70 border border-[#d4af37]/30 text-[#e8e2d4] hover:text-[#d4af37] hover:bg-black/90 flex items-center justify-center backdrop-blur"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>
        </div>

        {/* Chat panel */}
        <div
          className={cn(
            'flex flex-col min-h-0 flex-1 md:flex-none md:w-[390px] border-t md:border-t-0 md:border-s border-[#d4af37]/12 bg-[#0d0d11]',
            viewMode === 'game' && 'hidden'
          )}
        >
          {/* Chat scope tabs — global lobby vs this room */}
          <div
            className="shrink-0 grid grid-cols-2 gap-1 p-2 border-b border-[#d4af37]/12 bg-[#0c0c0f]/70"
            role="tablist"
            aria-label="Chat scope"
          >
            <button
              type="button"
              role="tab"
              aria-selected={chatTab === 'global'}
              onClick={() => setChatTab('global')}
              className={cn(
                'relative h-9 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-1.5',
                chatTab === 'global'
                  ? 'bg-gradient-to-b from-[#d4af37]/25 to-[#d4af37]/10 gold-text border border-[#d4af37]/35'
                  : 'text-[#8d8878] hover:text-[#c9c3b4] border border-transparent'
              )}
            >
              <Globe2 className="w-4 h-4" />
              Global
              {unreadGlobal > 0 && chatTab !== 'global' && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 rounded-full bg-[#d4af37] text-black text-[9px] font-bold flex items-center justify-center px-1">
                  {unreadGlobal > 9 ? '9+' : unreadGlobal}
                </span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={chatTab === 'room'}
              onClick={() => setChatTab('room')}
              className={cn(
                'relative h-9 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-1.5',
                chatTab === 'room'
                  ? 'bg-gradient-to-b from-[#d4af37]/25 to-[#d4af37]/10 gold-text border border-[#d4af37]/35'
                  : 'text-[#8d8878] hover:text-[#c9c3b4] border border-transparent'
              )}
            >
              <MessageSquare className="w-4 h-4" />
              Room
              {unread > 0 && chatTab !== 'room' && roomCode && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 rounded-full bg-[#d4af37] text-black text-[9px] font-bold flex items-center justify-center px-1">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </button>
          </div>

          {/* Room tab with no room joined → join/create card instead of chat */}
          {roomCtaMode && (
            <div className="flex-1 min-h-0 overflow-y-auto chat-scroll p-4 space-y-4">
              <div className="text-center space-y-1.5 py-1">
                <Gamepad2 className="w-8 h-8 text-[#3a382f] mx-auto" />
                <p className="text-sm font-bold text-[#c9c3b4]">You are not in a room</p>
                <p className="text-xs text-[#6d6960]">
                  Create one or join your squad — the global lobby keeps running meanwhile 🌍
                </p>
              </div>

              <div className="space-y-2.5 rounded-xl border border-white/5 bg-[#121216] p-3">
                <p className="text-[11px] font-bold uppercase tracking-wider text-[#a8a294]">
                  Join with code
                </p>
                <Input
                  value={joinCode}
                  onChange={(e) =>
                    setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))
                  }
                  placeholder="Room code e.g. K7X2QM4P"
                  maxLength={8}
                  aria-label="Room code"
                  className="h-10 bg-[#141419] border-[#d4af37]/20 text-center font-bold tracking-[0.25em] placeholder:font-normal placeholder:tracking-normal placeholder:text-sm placeholder:text-[#5d594e] focus-visible:ring-[#d4af37]/40 focus-visible:border-[#d4af37]/50"
                />
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6d6960] pointer-events-none" />
                  <Input
                    type="password"
                    value={joinPassword}
                    onChange={(e) => setJoinPassword(e.target.value.replace(/\s/g, '').slice(0, 16))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && joinCode.length >= 4) joinRoom()
                    }}
                    placeholder="Password (if locked)"
                    maxLength={16}
                    dir="ltr"
                    aria-label="Room password"
                    className="h-10 pl-9 bg-[#141419] border-[#d4af37]/20 placeholder:text-[#5d594e] focus-visible:ring-[#d4af37]/40 focus-visible:border-[#d4af37]/50"
                  />
                </div>
                <Button
                  onClick={() => joinRoom()}
                  disabled={busy !== null || conn !== 'online' || joinCode.length < 4}
                  className="gold-btn w-full h-10 font-bold rounded-lg border border-[#f3d27a]/40"
                >
                  {busy === 'join' ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> Joining...
                    </>
                  ) : (
                    'Join Room 🚪'
                  )}
                </Button>
              </div>

              <div className="flex items-center gap-2 text-[10px] text-[#5d594e]">
                <span className="flex-1 h-px bg-white/5" /> or <span className="flex-1 h-px bg-white/5" />
              </div>

              <div className="space-y-2.5 rounded-xl border border-white/5 bg-[#121216] p-3">
                <p className="text-[11px] font-bold uppercase tracking-wider text-[#a8a294]">
                  Create a new room
                </p>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6d6960] pointer-events-none" />
                  <Input
                    type="password"
                    value={createPassword}
                    onChange={(e) => setCreatePassword(e.target.value.replace(/\s/g, '').slice(0, 16))}
                    placeholder="Optional room password"
                    maxLength={16}
                    dir="ltr"
                    aria-label="New room password"
                    className="h-10 pl-9 bg-[#141419] border-[#d4af37]/20 placeholder:text-[#5d594e] focus-visible:ring-[#d4af37]/40 focus-visible:border-[#d4af37]/50"
                  />
                </div>
                <Button
                  onClick={createRoom}
                  disabled={busy !== null || conn !== 'online'}
                  className="gold-btn w-full h-10 font-bold rounded-lg border border-[#f3d27a]/40"
                >
                  {busy === 'create' ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> Creating...
                    </>
                  ) : (
                    'Create Room 🎮'
                  )}
                </Button>
              </div>

              {lastRoom && (
                <button
                  type="button"
                  onClick={() => joinRoom(lastRoom)}
                  disabled={busy !== null}
                  className="w-full flex items-center justify-center gap-2 h-10 rounded-xl border border-[#d4af37]/20 bg-transparent text-xs font-semibold text-[#a8a294] hover:text-[#e8e2d4] hover:border-[#d4af37]/45 transition-colors disabled:opacity-40"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Rejoin last room — <span className="tracking-widest text-[#d4af37]">{lastRoom}</span>
                </button>
              )}
            </div>
          )}

          {/* Messages */}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className={cn(
              'flex-1 min-h-0 overflow-y-auto chat-scroll px-3 py-3 space-y-2',
              roomCtaMode && 'hidden'
            )}
          >
            {activeMessages.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center gap-2 py-10">
                {viewingGlobal ? (
                  <Globe2 className="w-8 h-8 text-[#3a382f]" />
                ) : (
                  <MessageSquare className="w-8 h-8 text-[#3a382f]" />
                )}
                <p className="text-sm text-[#8d8878]">
                  {viewingGlobal && !globalJoined
                    ? 'Joining the global lobby...'
                    : viewingGlobal
                      ? 'Say hi to everyone 🌍'
                      : 'Send the first message 😄'}
                </p>
                <p className="text-xs text-[#5d594e]">
                  {viewingGlobal
                    ? 'The open lobby — every player in one place'
                    : 'Try the quick buttons below'}
                </p>
              </div>
            )}
            {activeMessages.map((m) => {
              const isLive = liveIds.has(m.id)
              if (m.type === 'system')
                return (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.2 }}
                    className="flex items-center gap-2 py-1"
                  >
                    <span className="flex-1 h-px bg-gradient-to-l from-transparent via-[#d4af37]/20 to-transparent" />
                    <span className="text-[11px] text-[#8d8878]">{m.content}</span>
                    <span className="flex-1 h-px bg-gradient-to-r from-transparent via-[#d4af37]/20 to-transparent" />
                  </motion.div>
                )
              if (m.userId === myId)
                return (
                  <motion.div
                    key={m.id}
                    initial={isLive ? { opacity: 0, x: 28, y: 12, scale: 0.9 } : false}
                    animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
                    transition={{ type: 'spring', stiffness: 460, damping: 28, mass: 0.8 }}
                    className="flex items-start justify-end gap-2 pl-10"
                  >
                    <div className="max-w-[85%] flex flex-col items-end">
                      <div className="rounded-2xl rounded-tr-md gold-btn px-3 py-2 shadow-lg shadow-[#d4af37]/10">
                        <p dir="auto" className="text-sm leading-relaxed whitespace-pre-wrap break-words text-left">
                          {m.content}
                        </p>
                        <p className="text-[10px] opacity-60 mt-0.5 text-left flex items-center gap-1">
                          {fmtTime(m.ts)}
                          {m.isAdmin && (
                            <Crown className="w-3 h-3 crown-live fill-amber-100 text-[#3a2f10]" />
                          )}
                        </p>
                      </div>
                    </div>
                    <AvatarCircle user={m as RoomUser} />
                  </motion.div>
                )
              return (
                <motion.div
                  key={m.id}
                  initial={isLive ? { opacity: 0, x: -28, y: 12, scale: 0.9 } : false}
                  animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
                  transition={{ type: 'spring', stiffness: 460, damping: 28, mass: 0.8 }}
                  className="flex items-start gap-2 pr-10"
                >
                  <AvatarCircle user={m as RoomUser} />
                  <div className="max-w-[85%] flex flex-col items-start">
                    <div className="flex items-center gap-1.5 px-1">
                      {m.isAdmin && (
                        <Crown className="w-3.5 h-3.5 crown-live fill-amber-300 text-[#d4af37] shrink-0" />
                      )}
                      <span
                        className={cn('text-[11px] font-bold', m.isAdmin && 'admin-name')}
                        style={m.isAdmin ? undefined : { color: m.color }}
                      >
                        {m.name}
                      </span>
                      <span className="text-[10px] text-[#5d594e]">{fmtTime(m.ts)}</span>
                    </div>
                    <div
                      className={cn(
                        'rounded-2xl rounded-tl-md px-3 py-2 text-[#e8e2d4]',
                        m.isAdmin
                          ? 'bg-[#d4af37]/[0.08] border border-[#d4af37]/45 shadow-[0_0_18px_rgba(212,175,55,0.14)]'
                          : 'bg-[#17171c] border border-white/[0.07]'
                      )}
                    >
                      <p dir="auto" className="text-sm leading-relaxed whitespace-pre-wrap break-words text-left">
                        {m.content}
                      </p>
                    </div>
                  </div>
                </motion.div>
              )
            })}
          </div>

          {/* New messages pill */}
          {showNewMsgs && (
            <div className="relative shrink-0 h-0">
              <button
                type="button"
                onClick={() => scrollBottom()}
                className="absolute -top-9 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full gold-btn text-xs font-bold px-3 py-1.5 shadow-lg"
              >
                {activeUnread > 0
                  ? `${activeUnread} new message${activeUnread > 1 ? 's' : ''} ↓`
                  : 'Jump to latest ↓'}
              </button>
            </div>
          )}

          {/* Typing — slides in with springy bounce */}
          <div className="shrink-0 h-5 px-3 flex items-center">
            <AnimatePresence>
              {activeTypingNames.length > 0 && (
                <motion.span
                  key="typing-indicator"
                  initial={{ opacity: 0, y: 10, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 6, scale: 0.95 }}
                  transition={{ type: 'spring', stiffness: 520, damping: 26 }}
                  className="text-[11px] text-[#a8a294] flex items-center gap-1.5"
                >
                  <span className="flex gap-0.5 items-end h-3">
                    <span className="typing-dot w-1 h-1 rounded-full bg-[#d4af37] inline-block" />
                    <span className="typing-dot w-1 h-1 rounded-full bg-[#d4af37] inline-block" />
                    <span className="typing-dot w-1 h-1 rounded-full bg-[#d4af37] inline-block" />
                  </span>
                  {activeTypingNames.slice(0, 2).join(' and ')}
                  {activeTypingNames.length > 2 ? ' and others are typing...' : ' is typing...'}
                </motion.span>
              )}
            </AnimatePresence>
          </div>

          {/* Quick chats */}
          <div
            className={cn(
              'shrink-0 flex gap-1.5 overflow-x-auto no-scrollbar px-3 pb-2',
              roomCtaMode && 'hidden'
            )}
          >
            {QUICK_CHATS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => sendContent(q, chatTab)}
                className="shrink-0 rounded-full border border-[#d4af37]/20 bg-[#141419] px-3 py-1.5 text-xs font-semibold text-[#c9c3b4] hover:border-[#d4af37]/50 hover:bg-[#d4af37]/10 hover:text-[#d4af37] transition-colors"
              >
                {q}
              </button>
            ))}
          </div>

          {/* Input — glows while typing, shakes on spam errors */}
          <div className={cn('shrink-0 p-3 pt-0', roomCtaMode && 'hidden')}>
            <div
              onAnimationEnd={() => setInputShake(false)}
              className={cn(
                'flex items-center gap-2 rounded-xl transition-shadow duration-300',
                inputShake && 'input-shake',
                input.trim() && 'drop-shadow-[0_0_16px_rgba(212,175,55,0.22)]'
              )}
            >
              <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    title="Emoji"
                    className="h-10 w-10 shrink-0 rounded-lg border border-[#d4af37]/20 bg-[#141419] text-[#8d8878] hover:text-[#d4af37] hover:border-[#d4af37]/50 flex items-center justify-center transition-colors"
                  >
                    <Smile className="w-5 h-5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent side="top" align="end" sideOffset={8} className="w-64 p-2 bg-[#121216] border-[#d4af37]/25">
                  <div className="grid grid-cols-6 gap-1">
                    {EMOJIS.map((e) => (
                      <button
                        key={e}
                        type="button"
                        onClick={() => setInput((prev) => (prev + e).slice(0, 600))}
                        className="h-9 rounded-lg hover:bg-white/10 text-xl transition-colors"
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              <Input
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    sendContent(input, chatTab)
                  }
                }}
                placeholder="Type a message... (Enter to send)"
                maxLength={600}
                dir="auto"
                className={cn(
                  'flex-1 h-10 bg-[#141419] border-[#d4af37]/20 placeholder:text-[#5d594e] caret-[#d4af37] transition-all duration-300',
                  input.trim()
                    ? 'border-[#d4af37]/60 shadow-[0_0_18px_rgba(212,175,55,0.18)]'
                    : 'focus-visible:ring-[#d4af37]/40 focus-visible:border-[#d4af37]/50'
                )}
              />
              <motion.div
                animate={{ scale: input.trim() ? 1.08 : 1 }}
                whileTap={input.trim() ? { scale: 0.88 } : undefined}
                transition={{ type: 'spring', stiffness: 520, damping: 22 }}
                className="shrink-0"
              >
                <Button
                  onClick={() => sendContent(input, chatTab)}
                  disabled={!input.trim()}
                  size="icon"
                  className="gold-btn h-10 w-10 rounded-lg border border-[#f3d27a]/40 disabled:opacity-40"
                >
                  <Send className="w-4 h-4" />
                </Button>
              </motion.div>
            </div>
          </div>
        </div>
      </div>
      {adminOverlay}
    </div>
  )
}

