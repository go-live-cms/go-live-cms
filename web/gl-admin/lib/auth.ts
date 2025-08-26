import { login, logout, renewAccessToken } from "./api/sessions"

export interface AuthState {
  isAuthenticated: boolean
  user: any | null
  accessToken: string | null
  refreshToken: string | null
  tokenExpiry: number | null
}

export class AuthManager {
  private static instance: AuthManager
  private state: AuthState
  private refreshPromise: Promise<boolean> | null = null // prevent multiple simultaneous refreshes
  private lastRefreshAttempt: number = 0
  private readonly REFRESH_COOLDOWN = 5000
  private readonly TOKEN_BUFFER = 60000

  private constructor() {
    this.state = this.getStoredAuth()
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
    const refreshToken = localStorage.getItem("refresh_token")
    const user = localStorage.getItem("user")
    const tokenExpiry = localStorage.getItem("token_expiry")

    return {
      isAuthenticated: !!accessToken && this.isTokenValid(tokenExpiry),
      user: user ? JSON.parse(user) : null,
      accessToken,
      refreshToken,
      tokenExpiry: tokenExpiry ? parseInt(tokenExpiry) : null,
    }
  }

  private isTokenValid(expiryString: string | null): boolean {
    if (!expiryString) return false
    const expiry = parseInt(expiryString)
    return Date.now() < expiry - this.TOKEN_BUFFER
  }

  private isTokenExpired(): boolean {
    if (!this.state.tokenExpiry) return true
    return Date.now() >= this.state.tokenExpiry - this.TOKEN_BUFFER
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

      const tokenExpiry = response.expires_at ? response.expires_at * 1000 : Date.now() + 15 * 60 * 1000

      this.state = {
        isAuthenticated: true,
        user: response.user,
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        tokenExpiry,
      }

      if (typeof window !== "undefined") {
        localStorage.setItem("access_token", response.access_token)
        localStorage.setItem("refresh_token", response.refresh_token)
        localStorage.setItem("user", JSON.stringify(response.user))
        localStorage.setItem("token_expiry", tokenExpiry.toString())
      }

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
      if (this.state.refreshToken) {
        await logout({ refresh_token: this.state.refreshToken })
      }
    } catch (error) {
      console.error("Logout error:", error)
    } finally {
      this.clearAuth()
    }
  }

  private clearAuth(): void {
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
      localStorage.removeItem("refresh_token")
      localStorage.removeItem("user")
      localStorage.removeItem("token_expiry")
    }
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

    if (!this.state.refreshToken) {
      this.clearAuth()
      return false
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

      const response = await renewAccessToken({
        refresh_token: this.state.refreshToken!,
      })

      const tokenExpiry = response.expires_at ? response.expires_at * 1000 : Date.now() + 15 * 60 * 1000

      this.state.accessToken = response.access_token
      this.state.tokenExpiry = tokenExpiry
      this.state.isAuthenticated = true

      if (typeof window !== "undefined") {
        localStorage.setItem("access_token", response.access_token)
        localStorage.setItem("token_expiry", tokenExpiry.toString())
      }

      console.log("Token refreshed successfully")
      return true
    } catch (error) {
      console.error("Token refresh failed:", error)
      this.clearAuth()
      return false
    }
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
}

export const authManager = AuthManager.getInstance()
