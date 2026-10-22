import type { ReactNode } from "react"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import Icon from "@gl-admin/components/ui/Icon"
import "@gl-admin/assets/styles/components/ui/empty-state.scss"

type EmptyStateProps = {
  title: string
  description?: ReactNode
  // Name of an svg in assets/icons.
  icon?: string
  // Primary action(s), e.g. a "Create your first post" button.
  action?: ReactNode
  // "error" styles the state as a failure (a list that failed to load).
  variant?: "empty" | "error"
  className?: string
}

// Shown in place of a list with no items, or one that failed to load.
export default function EmptyState({
  title,
  description,
  icon,
  action,
  variant = "empty",
  className = "",
}: EmptyStateProps) {
  const { isDark } = useGoLive()
  const iconColor = variant === "error" ? "#d93025" : isDark ? "#949393" : "#838383"

  return (
    <div className={`gl-empty-state gl-empty-state--${variant} ${className}`} role={variant === "error" ? "alert" : undefined}>
      {icon && (
        <div className="gl-empty-state__icon">
          <Icon name={icon} color={iconColor} width="28" height="28" />
        </div>
      )}
      <h2 className="gl-empty-state__title">{title}</h2>
      {description && <p className="gl-empty-state__description">{description}</p>}
      {action && <div className="gl-empty-state__actions">{action}</div>}
    </div>
  )
}
