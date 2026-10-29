import { login, logout, RefreshError, renewAccessToken } from "./api/sessions"
import { getMe } from "./api/users"
import { ApiError } from "./api"

export interface AuthState {
  isAuthenticated: boolean
  user: any | null
  accessToken: string | null
  refreshToken: null
  tokenExpiry: number | null
}

// Why the last sign-out happened, so whoever sends the user to the login page
// can tell them: "session-expired" when a refresh failed (the session was
// revoked or ran out), "password-changed" when they must sign in again with
// a new password, "signed-out" when they asked to.
export type SignOutReason = "signed-out" | "session-expired" | "password-changed"

// The bit of the signed-in user kept in localStorage, for UI that runs without
// a session restore (the public site's header, the login page's "already
// signed in?" check). Display data only: never a token, and nothing to
// authorize with. It can outlive the server session; whatever needs the
// session restores it and clears this when that fails.
export interface DisplayUser {
  id: number
  username: string
  full_name?: string
}

// The access token lives only in memory (#13): anything in Web Storage can be
// read by any script that runs on the origin. A page load restores the session
// with POST /auth/refresh, which presents the httpOnly refresh cookie.
const LEGACY_STORAGE_KEYS = ["access_token", "token_expiry", "user"]
const DISPLAY_USER_KEY = "gl-auth-user"

// The API rotates the refresh token on every refresh and treats a spent one as
// stolen (409, every session of the user blocked). Tabs share the cookie, so
// two tabs refreshing at once would present the same token and the slower one
// would trip that. Refreshes therefore take a cross-tab Web Lock, and a tab
// that gets a token tells the others over a BroadcastChannel so they use it
// instead of rotating again.
const REFRESH_LOCK = "gl-auth-refresh"
const AUTH_CHANNEL = "gl-auth"

type ChannelMessage =
  | { type: "token"; access_token: string; tokenExpiry: number; userId: number | null }
  | { type: "signed-out"; reason: SignOutReason }

const EMPTY_STATE: AuthState = {
  isAuthenticated: false,
  user: null,
  accessToken: null,
  refreshToken: null,
  tokenExpiry: null,
}

export class AuthManager {
  private static instance: AuthManager
  private state: AuthState = { ...EMPTY_STATE }
  private refreshPromise: Promise<boolean> | null = null // prevent multiple simultaneous refreshes
  private restorePromise: Promise<boolean> | null = null
  private lastRefreshAttempt: number = 0
  private refreshTimer: NodeJS.Timeout | null = null
  private readonly REFRESH_COOLDOWN = 5000
  private readonly TOKEN_BUFFER = 60000
  private listeners: ((state: AuthState) => void)[] = []
  private signOutReason: SignOutReason | null = null
  private channel: BroadcastChannel | null = null
  // Set while the last refresh was rate limited: how long it asked us to wait.
  private rateLimitDelayMs: number | null = null

  private constructor() {
    if (typeof window === "undefined") return

    try {
      for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key)
    } catch {
      // storage blocked; nothing was stored there either
    }

    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(AUTH_CHANNEL)
      this.channel.onmessage = (event: MessageEvent<ChannelMessage>) => this.onChannelMessage(event.data)
      // Node's BroadcastChannel (tests) would otherwise keep the process alive.
      ;(this.channel as any).unref?.()
    }
  }

  static getInstance(): AuthManager {
    if (!AuthManager.instance) {
      AuthManager.instance = new AuthManager()
    }
    return AuthManager.instance
  }

  private onChannelMessage(message: ChannelMessage): void {
    if (message?.type === "token") {
      const myId = this.state.user?.id ?? null
      if (myId !== null && message.userId !== null && message.userId !== myId) {
        // Another tab signed in as someone else, replacing the shared refresh
        // cookie. Don't let this tab act as that user under the old one's UI:
        // sign it out (AuthGuard sends it to /login, which restores the new
        // session) instead of adopting the token.
        // The display user in storage is already the new one's; keep it.
        this.clearAuth("signed-out", false)
        return
      }
      // Ignore a token older than the one we hold (messages can cross).
      if (this.state.tokenExpiry && message.tokenExpiry < this.state.tokenExpiry) return
      this.setToken(message.access_token, message.tokenExpiry, false)
    } else if (message?.type === "signed-out") {
      this.clearAuth(message.reason)
    }
  }

  private broadcast(message: ChannelMessage): void {
    try {
      this.channel?.postMessage(message)
    } catch (error) {
      console.error("Auth broadcast failed:", error)
    }
  }

  private isTokenExpired(): boolean {
    if (!this.state.tokenExpiry) return true
    const expired = Date.now() >= this.state.tokenExpiry - this.TOKEN_BUFFER

    if (expired && typeof console !== "undefined") {
      console.log("🔒 Access token expired or expiring soon")
    }

    return expired
  }

  private shouldRefresh(): boolean {
    // Don't refresh if we recently attempted
    if (Date.now() - this.lastRefreshAttempt < this.REFRESH_COOLDOWN) {
      return false
    }

    // Don't refresh if already refreshing
    if (this.refreshPromise) {
      return false
    }

    // Only refresh if token is expired or close to expiry

    return this.isTokenExpired()
  }

  // On failure, status is the API's HTTP status when it answered (absent when
  // the request never got there, e.g. the API is unreachable), and a 429's
  // Retry-After when it sent one.
  async login(
    username: string,
    password: string
  ): Promise<{ success: boolean; error?: string; status?: number; retryAfterSeconds?: number | null }> {
    try {
      const response = await login({ username, password })

      this.signOutReason = null
      this.state.user = response.user
      this.storeDisplayUser(response.user)
      this.adoptAccessToken(response)

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Login failed",
        status: error instanceof ApiError ? error.status : undefined,
        retryAfterSeconds: error instanceof ApiError ? error.retryAfterSeconds : undefined,
      }
    }
  }

  // Revokes the session server-side (the endpoint reads the refresh cookie)
  // and signs every open tab out.
  async logout(reason: SignOutReason = "signed-out"): Promise<void> {
    try {
      await logout(this.state.accessToken || undefined)
    } catch (error) {
      console.error("Logout error:", error)
    } finally {
      this.clearAuth(reason)
      this.broadcast({ type: "signed-out", reason })
    }
  }

  getSignOutReason(): SignOutReason | null {
    return this.signOutReason
  }

  private clearAuth(reason: SignOutReason = "session-expired", clearDisplayUser = true): void {
    this.signOutReason = reason
    const wasAuthenticated = this.state.isAuthenticated

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }

    this.state = { ...EMPTY_STATE }

    this.refreshPromise = null
    this.lastRefreshAttempt = 0

    if (clearDisplayUser) this.storeDisplayUser(null)

    // A failed session restore leaves a signed-out tab signed out: nothing
    // changed, and subscribers (AuthGuard) would read it as a session that
    // just expired.
    if (wasAuthenticated) this.notifyListeners()
  }

  // Signs this tab in from the refresh cookie when it holds no usable access
  // token (every page load: the token is never stored), then loads the user.
  // Concurrent callers share one restore. A rate-limited refresh (429) is
  // retried after Retry-After, a few times, rather than reported as signed
  // out: the session is fine. Resolves false when there is no session.
  async restoreSession(): Promise<boolean> {
    if (this.isValidAuth()) return true
    if (!this.restorePromise) {
      this.restorePromise = (async () => {
        let refreshed = await this.forceRefresh()
        for (let attempt = 0; !refreshed && this.rateLimitDelayMs !== null && attempt < 3; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, this.rateLimitDelayMs!))
          // The scheduled retry (or another tab) may have got a token meanwhile.
          refreshed = this.isValidAuth() || (await this.forceRefresh())
        }
        if (refreshed && this.state.isAuthenticated && !this.state.user) {
          await this.refreshUser()
          // /users/me failed: fall back to the last session's display data so
          // the UI isn't anonymous. It has no role; PostForm re-reads that.
          if (!this.state.user) this.state.user = this.getDisplayUser()
        }
        return refreshed && this.state.isAuthenticated
      })().finally(() => {
        this.restorePromise = null
      })
    }
    return this.restorePromise
  }

  async refreshAccessToken(): Promise<boolean> {
    // return existing refresh promise if already in progress
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    // check if we should refresh
    if (!this.shouldRefresh()) {
      return this.state.isAuthenticated // Token is still valid (or a refresh just ran)
    }

    return this.forceRefresh()
  }

  // Refreshes even when the local expiry says the token is still good. The
  // server can revoke a token early (a password change rejects every access
  // token issued before it), and only its 401 tells us; apiCall calls this
  // then. Shares an in-flight refresh. Returns false, after clearing auth, if
  // the refresh session was revoked too. A rate-limited refresh (429) also
  // returns false but keeps the user signed in and retries later.
  async forceRefresh(): Promise<boolean> {
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.lastRefreshAttempt = Date.now()

    this.refreshPromise = this.performRefresh()
    try {
      return await this.refreshPromise
    } finally {
      this.refreshPromise = null
    }
  }

  private async performRefresh(): Promise<boolean> {
    const tokenAtStart = this.state.accessToken
    this.rateLimitDelayMs = null
    // Another tab handed us a token since this refresh began (it refreshed
    // while we waited for the lock): use it instead of rotating again.
    const gotNewerToken = () =>
      !!this.state.accessToken && this.state.accessToken !== tokenAtStart && !this.isTokenExpired()
    try {
      await this.withRefreshLock(async (crossTab) => {
        // Let a token broadcast by the tab that held the lock arrive first.
        if (crossTab) await new Promise((resolve) => setTimeout(resolve, 0))
        if (gotNewerToken()) return

        console.log("refreshing access token...")
        const response = await renewAccessToken() // No parameters - uses HttpOnly cookie
        // Adopt (and broadcast) while still holding the lock, so a tab
        // waiting on it is more likely to have the token before it runs.
        this.adoptAccessToken(response)
        console.log("Token refreshed successfully")
      })
      return true
    } catch (error) {
      if (error instanceof RefreshError && error.status === 429) {
        // The API's refresh rate limit (#190) says nothing about the session,
        // so stay signed in and try again once the limit allows.
        console.warn("Token refresh rate limited; retrying later")
        this.scheduleRefreshRetry(error.retryAfterSeconds)
        return false
      }
      if (this.state.accessToken && this.state.accessToken !== tokenAtStart) {
        // A new token was adopted while this refresh was in flight (e.g. a
        // password change, which also blocked the session this refresh
        // presented). Its failure says nothing about the new session.
        return true
      }
      if (tokenAtStart) console.error("Token refresh failed:", error)
      this.clearAuth()
      return false
    }
  }

  // Runs fn while holding the cross-tab refresh lock. Web Locks need a secure
  // context (https or localhost); without them refreshes are only serialized
  // within this tab. If the lock itself can't be had (request rejects before
  // running fn, e.g. a SecurityError), refresh without it rather than treating
  // that as a dead session.
  private async withRefreshLock(fn: (crossTab: boolean) => Promise<void>): Promise<void> {
    const locks = typeof navigator !== "undefined" ? (navigator as any).locks : undefined
    if (!locks?.request) return fn(false)
    let ran = false
    try {
      await locks.request(REFRESH_LOCK, () => {
        ran = true
        return fn(true)
      })
    } catch (error) {
      if (ran) throw error
      console.warn("Refresh lock unavailable; refreshing without it:", error)
      await fn(false)
    }
  }

  private scheduleRefreshRetry(retryAfterSeconds: number | null): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
    }
    if (typeof window === "undefined") return

    const delay = Math.max(1, retryAfterSeconds ?? 30) * 1000
    this.rateLimitDelayMs = delay
    this.refreshTimer = setTimeout(() => {
      void this.forceRefresh()
    }, delay)
  }

  private scheduleTokenRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
    }

    if (!this.state.tokenExpiry || typeof window === "undefined") return

    // Tabs share one token (and so one expiry). Jitter keeps their timers from
    // firing together: the first refresh is broadcast and reschedules the
    // rest, which matters where there are no Web Locks to serialize them.
    const timeUntilExpiry = this.state.tokenExpiry - Date.now()
    const jitter = Math.random() * 30000
    const refreshTime = Math.max(30000, timeUntilExpiry - 2 * 60 * 1000 - jitter)

    console.log(`⏰ Token refresh scheduled in ${Math.round(refreshTime / 1000)}s`)

    this.refreshTimer = setTimeout(async () => {
      console.log("🔄 Auto-refreshing token...")
      await this.refreshAccessToken()
    }, refreshTime)
  }

  // check if authentication is valid without forcing refresh
  isValidAuth(): boolean {
    return this.state.isAuthenticated && !this.isTokenExpired()
  }

  // Re-reads the user from GET /users/me so role changes since login (demotion or
  // promotion) take effect without logging out. The cached user is kept if this fails.
  async refreshUser(): Promise<any | null> {
    const token = this.state.accessToken
    if (!token) return this.state.user
    try {
      const { user } = await getMe(token)
      this.setUser(user)
      return user
    } catch (error) {
      console.error("Failed to refresh user:", error)
      return this.state.user
    }
  }

  // Replaces the cached user with one the API already returned (e.g. from a
  // profile save), without another GET /users/me.
  setUser(user: any): void {
    this.state.user = user
    this.storeDisplayUser(user)
    this.notifyListeners()
  }

  // The signed-in user's display data without a session restore: the in-memory
  // user once signed in, else what the last session left in storage. Only for
  // showing who is (probably) signed in; it authorizes nothing.
  getDisplayUser(): DisplayUser | null {
    if (this.state.user) return toDisplayUser(this.state.user)
    if (typeof window === "undefined") return null
    try {
      const stored = localStorage.getItem(DISPLAY_USER_KEY)
      return stored ? JSON.parse(stored) : null
    } catch {
      return null
    }
  }

  private storeDisplayUser(user: any | null): void {
    if (typeof window === "undefined") return
    try {
      if (user) localStorage.setItem(DISPLAY_USER_KEY, JSON.stringify(toDisplayUser(user)))
      else localStorage.removeItem(DISPLAY_USER_KEY)
    } catch {
      // storage blocked or full; the hint is optional
    }
  }

  // Switches to an access token the API handed back outside the refresh flow
  // (e.g. after changing your own password, which invalidates the old token).
  // Accepts the same fields as the login/refresh responses. Other tabs adopt
  // it too.
  adoptAccessToken(response: { access_token: string; access_token_expires_at?: string; expires_at?: number }): void {
    // Use access_token_expires_at or expires_at field from response
    const tokenExpiry = response.access_token_expires_at
      ? new Date(response.access_token_expires_at).getTime()
      : response.expires_at
        ? response.expires_at * 1000
        : Date.now() + 15 * 60 * 1000

    this.setToken(response.access_token, tokenExpiry, true)
  }

  private setToken(accessToken: string, tokenExpiry: number, broadcast: boolean): void {
    this.state.accessToken = accessToken
    this.state.tokenExpiry = tokenExpiry
    this.state.isAuthenticated = true

    if (broadcast) {
      this.broadcast({ type: "token", access_token: accessToken, tokenExpiry, userId: this.state.user?.id ?? null })
    }

    this.scheduleTokenRefresh()
    this.notifyListeners()
  }

  getState(): AuthState {
    return { ...this.state }
  }

  getAccessToken(): string | null {
    return this.state.accessToken
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index > -1) {
        this.listeners.splice(index, 1)
      }
    }
  }

  private notifyListeners() {
    this.listeners.forEach((listener) => {
      try {
        listener({ ...this.state })
      } catch (error) {
        console.error("Error in auth state listener:", error)
      }
    })
  }
}

function toDisplayUser(user: any): DisplayUser {
  return { id: user.id, username: user.username, full_name: user.full_name }
}

export const authManager = AuthManager.getInstance()
