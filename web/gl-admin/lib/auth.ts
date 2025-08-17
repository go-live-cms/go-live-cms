import { api } from "./api";

export interface AuthState {
  isAuthenticated: boolean;
  user: any | null;
  accessToken: string | null;
  refreshToken: string | null;
}

export class AuthManager {
  private static instance: AuthManager;
  private state: AuthState;

  private constructor() {
    this.state = this.getStoredAuth();
  }

  static getInstance(): AuthManager {
    if (!AuthManager.instance) {
      AuthManager.instance = new AuthManager();
    }
    return AuthManager.instance;
  }

  private getStoredAuth(): AuthState {
    if (typeof window === "undefined") {
      return {
        isAuthenticated: false,
        user: null,
        accessToken: null,
        refreshToken: null,
      };
    }

    const accessToken = localStorage.getItem("access_token");
    const refreshToken = localStorage.getItem("refresh_token");
    const user = localStorage.getItem("user");

    return {
      isAuthenticated: !!accessToken,
      user: user ? JSON.parse(user) : null,
      accessToken,
      refreshToken,
    };
  }

  async login(
    username: string,
    password: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await api.login({ username, password });

      this.state = {
        isAuthenticated: true,
        user: response.user,
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
      };

      if (typeof window !== "undefined") {
        localStorage.setItem("access_token", response.access_token);
        localStorage.setItem("refresh_token", response.refresh_token);
        localStorage.setItem("user", JSON.stringify(response.user));
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Login failed",
      };
    }
  }

  async logout(): Promise<void> {
    try {
      if (this.state.refreshToken) {
        await api.logout({ refresh_token: this.state.refreshToken });
      }
    } catch (error) {
      console.error("Logout error:", error);
    } finally {
      this.clearAuth();
    }
  }

  private clearAuth(): void {
    this.state = {
      isAuthenticated: false,
      user: null,
      accessToken: null,
      refreshToken: null,
    };

    if (typeof window !== "undefined") {
      localStorage.removeItem("access_token");
      localStorage.removeItem("refresh_token");
      localStorage.removeItem("user");
    }
  }

  async refreshAccessToken(): Promise<boolean> {
    if (!this.state.refreshToken) return false;

    try {
      const response = await api.renewAccessToken({
        refresh_token: this.state.refreshToken,
      });

      this.state.accessToken = response.access_token;

      if (typeof window !== "undefined") {
        localStorage.setItem("access_token", response.access_token);
      }

      return true;
    } catch (error) {
      this.clearAuth();
      return false;
    }
  }

  getState(): AuthState {
    return { ...this.state };
  }

  getAccessToken(): string | null {
    return this.state.accessToken;
  }
}

export const authManager = AuthManager.getInstance();
