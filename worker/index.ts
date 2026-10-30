// ============================================================
// Combat Chat — Cloudflare Worker entry
// static assets + 3 API routes into the ChatHub Durable Object
// ============================================================
import { ChatHub, type Env } from './chat'

export { ChatHub }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const hubId = env.CHAT_HUB.idFromName('hub')
    const hub = env.CHAT_HUB.get(hubId)

    if (url.pathname === '/api/chat') {
      // pass the ORIGINAL request through — reconstructing it would drop the
      // Upgrade header and break the websocket handshake
      return hub.fetch(req)
    }
    if (url.pathname === '/api/new-room') {
      return hub.fetch(req)
    }
    if (url.pathname === '/api/probe') {
      return hub.fetch(req)
    }
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, at: Date.now() })
    }
    return env.ASSETS.fetch(req)
  },
} satisfies ExportedHandler<Env>
