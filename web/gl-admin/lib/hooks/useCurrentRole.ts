import { useEffect, useState } from "react"
import { authManager } from "@gl-admin/lib/auth"

// The signed-in user's role, kept current as auth state changes. A UI hint
// only (see lib/roles.ts): the API enforces the real check.
export function useCurrentRole(): string | undefined {
  const [role, setRole] = useState<string | undefined>(() => authManager.getState().user?.role)

  useEffect(() => authManager.subscribe((state) => setRole(state.user?.role)), [])

  return role
}
