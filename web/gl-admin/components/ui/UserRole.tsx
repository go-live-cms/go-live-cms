import { capitalize } from "@gl-admin/utils/formatting"
import Skeleton from "@gl-admin/components/ui/Skeleton"

// A user's role as plain text, the way the Users board shows it (#338): roles are
// not statuses, so no coloured pill.
export default function UserRole({ role }: { role: string | null }) {
  if (!role) {
    return <Skeleton width={72} height={12} />
  }

  return <span className="gl-user-role">{capitalize(role)}</span>
}
