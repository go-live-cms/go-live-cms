import type { ReactNode } from "react"
import Icon from "@gl-admin/components/ui/Icon"
import "@gl-admin/assets/styles/components/ui/empty-state.scss"

type EmptyStateProps = {
  // A subtitle-sized line: "No posts yet".
  title: string
  // One line of text-secondary saying what to do next.
  description?: ReactNode
  // Name of an svg in assets/icons, or an icon element (24px).
  icon?: string | ReactNode
  // The primary action (one), plus at most a secondary one.
  action?: ReactNode
  // "error" styles the state as a failure (a list that failed to load).
  variant?: "empty" | "error"
  // Less padding, for a panel or a small card.
  compact?: boolean
  className?: string
}

// Shown in place of a list with no items, or one that failed to load.
export default function EmptyState({
  title,
  description,
  icon,
  action,
  variant = "empty",
  compact = false,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`gl-empty-state gl-empty-state--${variant}${compact ? " gl-empty-state--compact" : ""} ${className}`}
      role={variant === "error" ? "alert" : undefined}
    >
      {icon && (
        <div className="gl-empty-state__icon" aria-hidden="true">
          {typeof icon === "string" ? <Icon name={icon} color="currentColor" width="24" height="24" /> : icon}
        </div>
      )}
      <div className="gl-empty-state__text">
        <h2 className="gl-empty-state__title">{title}</h2>
        {description && <p className="gl-empty-state__description">{description}</p>}
      </div>
      {action && <div className="gl-empty-state__actions">{action}</div>}
    </div>
  )
}
