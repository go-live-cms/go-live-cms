import { useRef, type ReactNode, type RefObject } from "react"
import { useEscape, useFocusTrap, useStableId } from "@gl-admin/components/ui/a11y"
import { IconButton } from "@gl-admin/components/ui/Button"
import { CloseIcon } from "@gl-admin/components/ui/icons"
import { useScrollLock } from "@gl-admin/components/ui/Modal"
import "@gl-admin/assets/styles/components/ui/modal.scss"

type DrawerProps = {
  isOpen: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  side?: "left" | "right"
  // Panel width; capped at the viewport less 48px.
  width?: number | string
  initialFocus?: RefObject<HTMLElement | null>
  // No header: `title` only names the dialog, the content fills the panel, and the
  // close button floats on the scrim beside it (the phone-width sidebar).
  bare?: boolean
  // Names the close button ("Close menu").
  closeLabel?: string
  id?: string
  className?: string
}

// A modal side panel (the phone-width sidebar, version history). Same keyboard rules
// as a dialog: focus trapped inside, Escape or the scrim closes, focus goes back.
export default function Drawer({
  isOpen,
  onClose,
  title,
  children,
  footer,
  side = "right",
  width = 400,
  initialFocus,
  bare = false,
  closeLabel = "Close",
  id: givenId,
  className = "",
}: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const id = useStableId("drawer")

  useScrollLock(isOpen)
  useEscape(isOpen, onClose)
  useFocusTrap(ref, isOpen, { initialFocus, preferIn: ".gl-drawer__content" })

  if (!isOpen) return null

  const close = <IconButton onClick={onClose} aria-label={closeLabel} icon={<CloseIcon />} className={bare ? "gl-drawer__float-close" : ""} />

  return (
    <div
      className={`gl-drawer-overlay gl-drawer-overlay--${side}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        id={givenId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={bare ? undefined : `${id}-title`}
        aria-label={bare ? title : undefined}
        tabIndex={-1}
        className={`gl-drawer gl-drawer--${side}${bare ? " gl-drawer--bare" : ""} ${className}`}
        style={{ width }}
      >
        {!bare && (
          <div className="gl-drawer__header">
            <h2 id={`${id}-title`} className="gl-drawer__title">
              {title}
            </h2>
            {close}
          </div>
        )}
        <div className="gl-drawer__content">{children}</div>
        {/* Last in the panel, so Tab reaches it after the content. */}
        {bare && close}
        {footer && <div className="gl-drawer__footer">{footer}</div>}
      </div>
    </div>
  )
}
