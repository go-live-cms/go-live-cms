import { WebsocketProvider } from "y-websocket"
import { Doc as YDoc } from "yjs"
import { IndexeddbPersistence } from "y-indexeddb"
import { authManager } from "../auth"
import { collabDebug, collabDebugEnabled, contentFingerprint } from "./debug"

const activeProviders = new Map<number, CollaborationProvider>()
const refCounts = new Map<number, number>()
const releaseTimers = new Map<number, number>()
const DESTROY_DELAY_MS = 750

export class CollaborationProvider {
  public doc: YDoc
  public provider: WebsocketProvider
  public persistence: IndexeddbPersistence
  private postId: number

  static getInstance(postId: number): CollaborationProvider {
    const t = releaseTimers.get(postId)
    if (t) {
      clearTimeout(t)
      releaseTimers.delete(postId)
    }

    const existing = activeProviders.get(postId)
    if (existing) {
      refCounts.set(postId, (refCounts.get(postId) ?? 0) + 1)
      return existing
    }

    const instance = new CollaborationProvider(postId)
    activeProviders.set(postId, instance)
    refCounts.set(postId, 1)
    return instance
  }

  private constructor(postId: number) {
    this.postId = postId

    if (typeof window === "undefined") {
      throw new Error("Collaboration is client-only")
    }

    this.doc = new YDoc()

    this.persistence = new IndexeddbPersistence(`post-${postId}`, this.doc)

    const user = authManager.getState().user
    const userInfo = {
      name: user?.full_name || user?.username || "Anonymous",
      color: this.generateUserColor(user?.id || 0),
      id: user?.id || 0,
    }

    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const wsHost = process.env.NODE_ENV === "development" ? "localhost:1234" : `${window.location.host}/collab`

    const token = authManager.getAccessToken()
    const baseUrl = `${wsProtocol}//${wsHost}/`

    this.provider = new WebsocketProvider(baseUrl, `post-${postId}`, this.doc, {
      params: token ? { ticket: token } : undefined,
      maxBackoffTime: 5000,
      resyncInterval: 2000,
      connect: true,
    })

    this.provider.awareness.setLocalStateField("user", userInfo)

    this.provider.on("connection-error", (event: any) => {
      console.error("Collaboration connection error:", event?.message || event)
    })

    this.provider.on("status", () => {})

    // Debug-gated instrumentation (localStorage GL_DEBUG_COLLAB=1) for diagnosing
    // the WS-restart instability. Logs reconnect cadence + the prosemirror fragment
    // fingerprint over time so we can see exactly when/why content reverts.
    if (collabDebugEnabled()) {
      const frag = this.doc.getXmlFragment("prosemirror")
      const fp = () => contentFingerprint(frag.toJSON())
      collabDebug("provider created", `post-${postId}`, fp())
      this.provider.on("status", (e: any) => collabDebug("ws status", e?.status, fp()))
      this.provider.on("sync", (isSynced: boolean) =>
        collabDebug("provider sync", isSynced, "wsconnected", this.provider.wsconnected, fp())
      )
      this.provider.on("connection-error", (e: any) =>
        collabDebug("connection-error", e?.message || String(e))
      )
      this.doc.on("update", (_update: Uint8Array, origin: unknown) => {
        const originName =
          origin == null ? "local" : (origin as any)?.constructor?.name ?? String(origin)
        collabDebug("doc update", "origin", originName, fp())
      })
    }
  }

  private generateUserColor(userId: number): string {
    const colors = ["#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F"]
    return colors[userId % colors.length]
  }

  public destroy() {
    activeProviders.delete(this.postId)

    this.provider?.disconnect()
    this.provider?.destroy()
    this.persistence?.destroy()
    this.doc?.destroy()
  }

  static release(postId: number) {
    const current = refCounts.get(postId) ?? 0
    if (current <= 1) {
      refCounts.delete(postId)
      const timer = window.setTimeout(() => {
        const inst = activeProviders.get(postId)
        if (!inst) return
        inst.provider?.disconnect()
        inst.provider?.destroy()
        inst.persistence?.destroy()
        inst.doc?.destroy()
        activeProviders.delete(postId)
        releaseTimers.delete(postId)
      }, DESTROY_DELAY_MS)
      releaseTimers.set(postId, timer)
    } else {
      refCounts.set(postId, current - 1)
    }
  }

  public getConnectionStatus(): "connecting" | "connected" | "disconnected" {
    if (!this.provider) return "disconnected"

    if (this.provider.wsconnected === true) {
      return "connected"
    }

    const ws = (this.provider as any).ws
    if (ws) {
      switch (ws.readyState) {
        case WebSocket.CONNECTING:
          return "connecting"
        case WebSocket.OPEN:
          return "connected"
        case WebSocket.CLOSING:
        case WebSocket.CLOSED:
          return "disconnected"
        default:
          return "disconnected"
      }
    }

    return "connecting"
  }

  public getConnectedUsers() {
    const states = this.provider?.awareness?.getStates()
    if (!states) return []

    return Array.from(states.entries())
      .map((entry) => {
        const [clientId, s] = entry as [number, any]
        return {
          clientId,
          ...(s?.user ?? {}),
        }
      })
      .filter((u: any) => u.clientId !== this.provider?.awareness?.clientID)
  }
}
