import { login, logout, renewAccessToken } from "./api/sessions"

export interface AuthState {
  isAuthenticated: boolean
  user: any | null
  accessToken: string | null
  refreshToken: null
  tokenExpiry: number | null
}

export class AuthManager {
  private static instance: AuthManager
  private state: AuthState
  private refreshPromise: Promise<boolean> | null = null // prevent multiple simultaneous refreshes
  private lastRefreshAttempt: number = 0
  private refreshTimer: NodeJS.Timeout | null = null
  private readonly REFRESH_COOLDOWN = 5000
  private readonly TOKEN_BUFFER = 60000
  private listeners: ((state: AuthState) => void)[] = []

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

  async login(username: string, password: string): Promise<{ success: boolean; error?: string }> {
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

      this.scheduleTokenRefresh()
      this.notifyListeners()

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Login failed",
      }
    }
  }

  async logout(): Promise<void> {
    try {
      await logout(this.state.accessToken || undefined)
    } catch (error) {
      console.error("Logout error:", error)
    } finally {
      this.clearAuth()
    }
  }

  private clearAuth(): void {
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

    this.lastRefreshAttempt = Date.now()

    this.refreshPromise = this.performRefresh()
    const result = await this.refreshPromise
    this.refreshPromise = null

    return result
  }

  private async performRefresh(): Promise<boolean> {
    try {
      console.log("refreshing access token...")

      const response = await renewAccessToken() // No parameters - uses HttpOnly cookie

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

      console.log("Token refreshed successfully")
      return true
    } catch (error) {
      console.error("Token refresh failed:", error)
      this.clearAuth()
      return false
    }
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
    this.listeners.forEach(listener => {
      try {
        listener({ ...this.state })
      } catch (error) {
        console.error('Error in auth state listener:', error)
      }
    })
  }
}

export const authManager = AuthManager.getInstance()
