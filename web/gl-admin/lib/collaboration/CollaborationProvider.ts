import { WebsocketProvider } from "y-websocket"
import { Doc as YDoc } from "yjs"
import { IndexeddbPersistence } from "y-indexeddb"
import { authManager } from "../auth"
import { createWSTicket } from "../api/sessions"

const activeProviders = new Map<number, CollaborationProvider>()
const refCounts = new Map<number, number>()
const releaseTimers = new Map<number, number>()
const DESTROY_DELAY_MS = 750

export class CollaborationProvider {
  public doc: YDoc
  public provider: WebsocketProvider
  public persistence: IndexeddbPersistence
  private postId: number

  static async getInstance(postId: number): Promise<CollaborationProvider> {
    const t = releaseTimers.get(postId)
    if (t) {
      clearTimeout(t)
      releaseTimers.delete(postId)
    }

    const existing = activeProviders.get(postId)
    if (existing) {
      refCounts.set(postId, (refCounts.get(postId) ?? 0) + 1)
      console.log(`Reusing existing provider for post ${postId} (refs=${refCounts.get(postId)})`)
      return existing
    }

    console.log(`Creating new provider for post ${postId}`)
    const instance = await CollaborationProvider.create(postId)
    activeProviders.set(postId, instance)
    refCounts.set(postId, 1)
    return instance
  }

  private static async create(postId: number): Promise<CollaborationProvider> {
    const instance = new CollaborationProvider(postId)
    await instance.initialize()
    return instance
  }

  private constructor(postId: number) {
    this.postId = postId

    if (typeof window === "undefined") {
      throw new Error("Collaboration is client-only")
    }

    this.doc = new YDoc()
    this.persistence = new IndexeddbPersistence(`post-${postId}`, this.doc)
  }

  private async initialize() {
    const user = authManager.getState().user
    const userInfo = {
      name: user?.full_name || user?.username || "Anonymous",
      color: this.generateUserColor(user?.id || 0),
      id: user?.id || 0,
    }

    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const wsHost = process.env.NODE_ENV === "development" ? "localhost:1234" : `${window.location.host}/collab`

    const ticket = await this.getWebSocketTicket(this.postId)
    if (!ticket) {
      throw new Error("Failed to get WebSocket ticket for collaboration")
    }

    const baseUrl = `${wsProtocol}//${wsHost}/`

    console.log("WebSocket URL:", baseUrl + "post-" + this.postId + "?ticket=***")

    this.provider = new WebsocketProvider(baseUrl, `post-${this.postId}`, this.doc, {
      params: { ticket },
      maxBackoffTime: 5000,
      resyncInterval: 2000,
      connect: true,
    })

    this.provider.awareness.setLocalStateField("user", userInfo)

    // Enhanced connection handling with security considerations
    this.provider.on("status", (event: any) => {
      console.log("Collaboration status event:", event)
    })

    this.provider.on("connection-close", (event: any) => {
      const { code, reason } = event
      console.log(`Collaboration connection closed: ${code} - ${reason}`)

      // Handle authentication failures
      if (code === 4401) {
        console.error("❌ Authentication failed - token invalid or expired")
        // Try to refresh token and reconnect
        this.handleAuthFailure()
      } else if (code === 4403) {
        console.error("❌ Access forbidden - insufficient permissions")
      }
    })

    this.provider.on("connection-error", (event: any) => {
      console.log("Collaboration connection error:", event?.message || event)
    })

    this.provider.on("connect", () => {
      console.log("✅ WebSocket connected successfully")
    })

    this.provider.on("disconnect", () => {
      console.log("🔌 WebSocket disconnected")
    })

    // Setup page unload cleanup
    this.setupCleanupHandlers()
  }

  private async getWebSocketTicket(postId: number): Promise<string | null> {
    try {
      const token = authManager.getAccessToken()
      if (!token) {
        throw new Error("No access token available")
      }

      const response = await createWSTicket(postId, token)
      return response.ticket
    } catch (error) {
      console.error("Failed to get WebSocket ticket:", error)
      return null
    }
  }

  private async handleAuthFailure() {
    try {
      console.log("🔄 Attempting to refresh token and reconnect...")
      const refreshed = await authManager.refreshAccessToken()

      if (refreshed) {
        // Get new token and attempt reconnect
        const newToken = authManager.getAccessToken()
        if (newToken && this.provider) {
          // Update provider with new token
          ;(this.provider as any).params = { token: newToken }
          this.provider.connect()
          console.log("✅ Token refreshed, attempting reconnection")
        }
      } else {
        console.error("❌ Token refresh failed - user needs to log in again")
        // Could emit an event here for the UI to handle
      }
    } catch (error) {
      console.error("❌ Auth recovery failed:", error)
    }
  }

  private setupCleanupHandlers() {
    // Clear selections on window blur/focus loss
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Clear awareness state when tab becomes hidden
        this.provider?.awareness?.setLocalStateField("cursor", null)
        this.provider?.awareness?.setLocalStateField("selection", null)
      }
    }

    // Clean disconnect on page unload
    const handleBeforeUnload = () => {
      if (this.provider) {
        this.provider.disconnect()
      }
    }

    // Add event listeners
    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("beforeunload", handleBeforeUnload)

    // Store cleanup function for later removal
    ;(this as any)._cleanup = () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }

  private generateUserColor(userId: number): string {
    const colors = ["#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F"]
    return colors[userId % colors.length]
  }

  public destroy() {
    // Run cleanup handlers
    if ((this as any)._cleanup) {
      ;(this as any)._cleanup()
    }

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
        console.log(`Destroyed provider for post ${postId}`)
      }, DESTROY_DELAY_MS)
      releaseTimers.set(postId, timer)
    } else {
      refCounts.set(postId, current - 1)
      console.log(`Decrement refs for post ${postId} -> ${refCounts.get(postId)}`)
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
