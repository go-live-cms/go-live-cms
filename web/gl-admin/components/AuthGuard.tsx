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
        // The access token only lives in memory, so after every page load
        // this restores the session from the refresh cookie (and loads the
        // user) before anything authenticated renders.
        if (!hasRedirected) {
          const restored = await authManager.restoreSession()

          if (restored) {
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

  // Auth can also be cleared after mount (a failed refresh after a 401, a
  // logout). Send the user to log in then, saying why, instead of leaving a
  // page whose every request now fails.
  useEffect(() => {
    return authManager.subscribe((state) => {
      if (state.isAuthenticated) return
      setHasRedirected(true)
      const params = new URLSearchParams({ redirect: window.location.pathname })
      const reason = authManager.getSignOutReason()
      if (reason && reason !== "signed-out") params.set("reason", reason)
      window.location.href = `${redirectTo}?${params}`
    })
  }, [redirectTo])

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
