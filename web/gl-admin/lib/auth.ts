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

export class AuthManager {
  private static instance: AuthManager
  private state: AuthState
  private refreshPromise: Promise<boolean> | null = null // prevent multiple simultaneous refreshes
  private lastRefreshAttempt: number = 0
  private refreshTimer: NodeJS.Timeout | null = null
  private readonly REFRESH_COOLDOWN = 5000
  private readonly TOKEN_BUFFER = 60000
  private listeners: ((state: AuthState) => void)[] = []
  private signOutReason: SignOutReason | null = null

  private constructor() {
    this.state = this.getStoredAuth()
    if (this.state.isAuthenticated && this.state.tokenExpiry) {
      this.scheduleTokenRefresh()
    }
  }

  static getInstance(): AuthManager {
    if (!AuthManager.instance) {
      AuthManager.instance = new AuthManager()
    }
    return AuthManager.instance
  }

  private getStoredAuth(): AuthState {
    if (typeof window === "undefined") {
      return {
        isAuthenticated: false,
        user: null,
        accessToken: null,
        refreshToken: null,
        tokenExpiry: null,
      }
    }

    const accessToken = localStorage.getItem("access_token")
    const user = localStorage.getItem("user")
    const tokenExpiry = localStorage.getItem("token_expiry")

    return {
      isAuthenticated: !!accessToken && this.isTokenValid(tokenExpiry),
      user: user ? JSON.parse(user) : null,
      accessToken,
      refreshToken: null,
      tokenExpiry: tokenExpiry ? parseInt(tokenExpiry) : null,
    }
  }

  private isTokenValid(expiryString: string | null): boolean {
    if (!expiryString) return false
    const expiry = parseInt(expiryString)
    const isValid = Date.now() < expiry - this.TOKEN_BUFFER

    if (!isValid && typeof console !== "undefined") {
      const timeUntilExpiry = expiry - Date.now()
      console.log(`🔒 Token expires in ${Math.round(timeUntilExpiry / 1000)}s (buffer: ${this.TOKEN_BUFFER / 1000}s)`)
    }

    return isValid
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
  // the request never got there, e.g. the API is unreachable).
  async login(username: string, password: string): Promise<{ success: boolean; error?: string; status?: number }> {
    try {
      const response = await login({ username, password })

      const tokenExpiry = response.access_token_expires_at
        ? new Date(response.access_token_expires_at).getTime()
        : response.expires_at
          ? response.expires_at * 1000
          : Date.now() + 15 * 60 * 1000

      this.state = {
        isAuthenticated: true,
        user: response.user,
        accessToken: response.access_token,
        refreshToken: null,
        tokenExpiry,
      }

      if (typeof window !== "undefined") {
        localStorage.setItem("access_token", response.access_token)
        localStorage.setItem("user", JSON.stringify(response.user))
        localStorage.setItem("token_expiry", tokenExpiry.toString())
      }

      this.signOutReason = null
      this.scheduleTokenRefresh()
      this.notifyListeners()

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Login failed",
        status: error instanceof ApiError ? error.status : undefined,
      }
    }
  }

  async logout(reason: SignOutReason = "signed-out"): Promise<void> {
    try {
      await logout(this.state.accessToken || undefined)
    } catch (error) {
      console.error("Logout error:", error)
    } finally {
      this.clearAuth(reason)
    }
  }

  getSignOutReason(): SignOutReason | null {
    return this.signOutReason
  }

  private clearAuth(reason: SignOutReason = "session-expired"): void {
    this.signOutReason = reason

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }

    this.state = {
      isAuthenticated: false,
      user: null,
      accessToken: null,
      refreshToken: null,
      tokenExpiry: null,
    }

    this.refreshPromise = null
    this.lastRefreshAttempt = 0

    if (typeof window !== "undefined") {
      localStorage.removeItem("access_token")
      localStorage.removeItem("user")
      localStorage.removeItem("token_expiry")
    }

    this.notifyListeners()
  }

  async refreshAccessToken(): Promise<boolean> {
    // return existing refresh promise if already in progress
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    // check if we should refresh
    if (!this.shouldRefresh()) {
      return true // Token is still valid
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
    try {
      console.log("refreshing access token...")

      const response = await renewAccessToken() // No parameters - uses HttpOnly cookie
      this.adoptAccessToken(response)

      console.log("Token refreshed successfully")
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
      console.error("Token refresh failed:", error)
      this.clearAuth()
      return false
    }
  }

  private scheduleRefreshRetry(retryAfterSeconds: number | null): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
    }
    if (typeof window === "undefined") return

    const delay = Math.max(1, retryAfterSeconds ?? 30) * 1000
    this.refreshTimer = setTimeout(() => {
      void this.forceRefresh()
    }, delay)
  }

  private scheduleTokenRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
    }

    if (!this.state.tokenExpiry || typeof window === "undefined") return

    const timeUntilExpiry = this.state.tokenExpiry - Date.now()
    const refreshTime = Math.max(30000, timeUntilExpiry - 2 * 60 * 1000)

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

  // get auth state with automatic refresh if needed
  async getValidState(): Promise<AuthState> {
    if (this.state.isAuthenticated && this.isTokenExpired()) {
      await this.refreshAccessToken()
    }
    return { ...this.state }
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
    if (typeof window !== "undefined") {
      localStorage.setItem("user", JSON.stringify(user))
    }
    this.notifyListeners()
  }

  // Switches to an access token the API handed back outside the refresh flow
  // (e.g. after changing your own password, which invalidates the old token).
  // Accepts the same fields as the login/refresh responses.
  adoptAccessToken(response: { access_token: string; access_token_expires_at?: string; expires_at?: number }): void {
    // Use access_token_expires_at or expires_at field from response
    const tokenExpiry = response.access_token_expires_at
      ? new Date(response.access_token_expires_at).getTime()
      : response.expires_at
        ? response.expires_at * 1000
        : Date.now() + 15 * 60 * 1000

    this.state.accessToken = response.access_token
    this.state.tokenExpiry = tokenExpiry
    this.state.isAuthenticated = true

    if (typeof window !== "undefined") {
      localStorage.setItem("access_token", response.access_token)
      localStorage.setItem("token_expiry", tokenExpiry.toString())
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

export const authManager = AuthManager.getInstance()
