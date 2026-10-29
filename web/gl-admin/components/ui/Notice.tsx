import type { ReactNode } from "react"
import { IconButton } from "@gl-admin/components/ui/Button"
import { CloseIcon, DangerIcon, InfoIcon, WarningIcon } from "@gl-admin/components/ui/icons"
import "@gl-admin/assets/styles/components/ui/notice.scss"

type NoticeProps = {
  tone?: "info" | "warning" | "danger"
  // Bold first line.
  title?: ReactNode
  children?: ReactNode
  // Buttons under (or, with `inline`, beside) the message.
  actions?: ReactNode
  // Shows a Dismiss button.
  onDismiss?: () => void
  // One line with the actions on the right (a banner across a panel).
  inline?: boolean
  // How it's announced. "alert" interrupts: only for a change the user must act on
  // now (access revoked). "status" for news that waits its turn. "none" for a notice
  // that's part of the page from the start.
  live?: "alert" | "status" | "none"
  className?: string
}

const ICONS = { info: <InfoIcon size={18} />, warning: <WarningIcon size={18} />, danger: <DangerIcon size={18} /> }
const ROLES = { alert: "alert", status: "status", none: "note" } as const

// An inline message inside a page or panel (#338): info, warning or danger.
export default function Notice({
  tone = "info",
  title,
  children,
  actions,
  onDismiss,
  inline = false,
  live = "none",
  className = "",
}: NoticeProps) {
  return (
    <div className={`gl-notice gl-notice--${tone}${inline ? " gl-notice--inline" : ""} ${className}`} role={ROLES[live]}>
      <span className="gl-notice__icon">{ICONS[tone]}</span>
      <div className="gl-notice__body">
        <div className="gl-notice__text">
          {title && <strong className="gl-notice__title">{title}</strong>}
          {children && <div className="gl-notice__message">{children}</div>}
        </div>
        {actions && <div className="gl-notice__actions">{actions}</div>}
      </div>
      {onDismiss && (
        <IconButton
          className="gl-notice__dismiss"
          size="sm"
          aria-label="Dismiss"
          icon={<CloseIcon size={14} />}
          onClick={onDismiss}
        />
      )}
    </div>
  )
}
