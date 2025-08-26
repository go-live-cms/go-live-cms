import { useEffect, useState } from "react"
import { authManager, type AuthState } from "@gl-admin/lib/auth"

interface AuthGuardProps {
  children: React.ReactNode
  fallback?: React.ReactNode
  redirectTo?: string
}

export default function AuthGuard({
  children,
  fallback = <div>Please log in to access this content.</div>,
  redirectTo = "/login",
}: AuthGuardProps) {
  const [authState, setAuthState] = useState<AuthState>({
    isAuthenticated: false,
    user: null,
    accessToken: null,
    refreshToken: null,
    tokenExpiry: null,
  })
  const [isLoading, setIsLoading] = useState(true)
  const [hasRedirected, setHasRedirected] = useState(false)

  useEffect(() => {
    const checkAuth = async () => {
      try {
        // First check if we have valid auth without forcing refresh
        if (authManager.isValidAuth()) {
          setAuthState(authManager.getState())
          setIsLoading(false)
          return
        }

        // If not valid, try to refresh only if we have a refresh token
        const currentState = authManager.getState()
        if (currentState.refreshToken && !hasRedirected) {
          console.log("🔍 Attempting token refresh in AuthGuard...")
          const refreshed = await authManager.refreshAccessToken()

          if (refreshed) {
            setAuthState(authManager.getState())
            setIsLoading(false)
            return
          }
        }

        // No valid auth and refresh failed - redirect to login
        if (!hasRedirected) {
          setHasRedirected(true)
          const currentPath = window.location.pathname
          console.log("🚪 Redirecting to login...")
          window.location.href = `${redirectTo}?redirect=${encodeURIComponent(currentPath)}`
          return
        }
      } catch (error) {
        console.error("AuthGuard error:", error)
        setIsLoading(false)
      }
    }

    checkAuth()
  }, [redirectTo, hasRedirected])

  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
        }}
      >
        <div>Loading...</div>
      </div>
    )
  }

  if (!authState.isAuthenticated || hasRedirected) {
    return <>{fallback}</>
  }

  return <>{children}</>
}
