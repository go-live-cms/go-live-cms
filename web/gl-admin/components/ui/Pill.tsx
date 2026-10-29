import type { ReactNode } from "react"
import "@gl-admin/assets/styles/components/ui/pill.scss"

// success: Published. warning: Draft. info: Scheduled. danger: Error. accent: Changes
// not published. neutral: Unpublished, View only. outline: Archived.
export type PillTone = "success" | "warning" | "info" | "danger" | "accent" | "neutral" | "outline"

type PillProps = {
  tone?: PillTone
  children: ReactNode
  // Replaces the 6px dot (14px icon, decorative). The dot or icon keeps status from
  // relying on hue alone; pass `dot={false}` only for a plain tag.
  icon?: ReactNode
  dot?: boolean
  className?: string
}

export default function Pill({ tone = "neutral", children, icon, dot = true, className = "" }: PillProps) {
  return (
    <span className={`gl-pill gl-pill--${tone} ${className}`}>
      {icon ? (
        <span className="gl-pill__icon" aria-hidden="true">
          {icon}
        </span>
      ) : (
        dot && <span className="gl-pill__dot" aria-hidden="true" />
      )}
      {children}
    </span>
  )
}
