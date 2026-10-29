import type { CSSProperties } from "react"
import "@gl-admin/assets/styles/components/ui/avatar.scss"

export type AvatarUser = {
  // Picks the colour, the same way collaborators' carets do (postCollab.ts): id % 8.
  id: number
  name: string
  // An uploaded picture; the initial is shown without one.
  src?: string | null
}

type AvatarSize = 20 | 24 | 28 | 32 | 40

export function presenceColor(id: number): string {
  return `var(--presence-${(Math.abs(Math.trunc(id)) % 8) + 1})`
}

function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase()
}

type AvatarProps = {
  user: AvatarUser
  size?: AvatarSize
  // Decorative next to a visible name; otherwise it's an image named after the user.
  decorative?: boolean
  className?: string
}

export default function Avatar({ user, size = 24, decorative = false, className = "" }: AvatarProps) {
  const style = { "--avatar-size": `${size}px`, background: presenceColor(user.id) } as CSSProperties
  const label = decorative ? { "aria-hidden": true as const } : { role: "img", "aria-label": user.name }

  return (
    <span className={`gl-avatar ${className}`} style={style} {...label}>
      {user.src ? <img src={user.src} alt="" /> : initial(user.name)}
    </span>
  )
}

type AvatarStackProps = {
  users: AvatarUser[]
  // Avatars shown before the rest collapse into "+n".
  max?: number
  size?: AvatarSize
  // Names the group for screen readers; defaults to the list of names.
  label?: string
  className?: string
}

// Overlapping avatars (post authors, people editing). One image for assistive tech,
// named after everyone in it.
export function AvatarStack({ users, max = 3, size = 24, label, className = "" }: AvatarStackProps) {
  const shown = users.length > max ? users.slice(0, max - 1) : users
  const rest = users.length - shown.length
  const style = { "--avatar-size": `${size}px` } as CSSProperties

  return (
    <span
      className={`gl-avatar-stack ${className}`}
      style={style}
      role="img"
      aria-label={label ?? users.map((u) => u.name).join(", ")}
    >
      {shown.map((u) => (
        <Avatar key={u.id} user={u} size={size} decorative />
      ))}
      {rest > 0 && (
        <span className="gl-avatar gl-avatar--more" aria-hidden="true">
          +{rest}
        </span>
      )}
    </span>
  )
}
