import { useEffect, useState } from "react"
import { authManager } from "@gl-admin/lib/auth"

// The cached signed-in user, re-rendering when authManager changes it (e.g.
// refreshUser() after a profile save), so the sidebar shows the new name.
export function useAuthUser() {
  const [user, setUser] = useState(() => authManager.getState().user)

  useEffect(() => {
    setUser(authManager.getState().user)
    return authManager.subscribe((state) => setUser(state.user))
  }, [])

  return user
}
