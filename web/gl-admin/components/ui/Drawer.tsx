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
}: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const id = useStableId("drawer")

  useScrollLock(isOpen)
  useEscape(isOpen, onClose)
  useFocusTrap(ref, isOpen, { initialFocus, preferIn: ".gl-drawer__content" })

  if (!isOpen) return null

  return (
    <div
      className={`gl-drawer-overlay gl-drawer-overlay--${side}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        className={`gl-drawer gl-drawer--${side}`}
        style={{ width }}
      >
        <div className="gl-drawer__header">
          <h2 id={`${id}-title`} className="gl-drawer__title">
            {title}
          </h2>
          <IconButton onClick={onClose} aria-label="Close" icon={<CloseIcon />} />
        </div>
        <div className="gl-drawer__content">{children}</div>
        {footer && <div className="gl-drawer__footer">{footer}</div>}
      </div>
    </div>
  )
}
