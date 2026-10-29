import type { ReactNode } from "react"
import { ForbiddenPage } from "@gl-admin/components/errors/ErrorPages"
import { useCurrentRole } from "@gl-admin/lib/hooks/useCurrentRole"

type RequireRoleProps = {
  // A role check from lib/roles.ts (isSiteAdmin, isContentModerator, ...).
  allow: (role: string | null | undefined) => boolean
  // What's refused, plural, for the 403 page: "Settings are open to admins only."
  area: string
  children: ReactNode
}

// Shows the 403 page instead of a page the signed-in role can't use (#339). A UI hint
// like the sidebar's (lib/roles.ts): the API refuses the requests either way.
export default function RequireRole({ allow, area, children }: RequireRoleProps) {
  const role = useCurrentRole()
  return allow(role) ? <>{children}</> : <ForbiddenPage area={area} />
}
