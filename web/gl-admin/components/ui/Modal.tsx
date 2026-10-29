import { useEffect, useRef, type ReactNode, type RefObject } from "react"
import { useEscape, useFocusTrap, useStableId } from "@gl-admin/components/ui/a11y"
import { IconButton } from "@gl-admin/components/ui/Button"
import { CloseIcon } from "@gl-admin/components/ui/icons"
import "@gl-admin/assets/styles/components/ui/modal.scss"

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  // A line under the title, also read as the dialog's description.
  description?: ReactNode
  children: ReactNode
  // small 440px (confirmations), medium 520px (forms), large 880px, fullscreen.
  size?: "small" | "medium" | "large" | "fullscreen"
  showCloseButton?: boolean
  showHeader?: boolean
  footer?: ReactNode
  // "alertdialog" for confirmations that interrupt (delete, discard changes).
  role?: "dialog" | "alertdialog"
  // What gets focus on open; by default the first control in the body.
  initialFocus?: RefObject<HTMLElement | null>
  // Clicking the scrim closes; turn off when closing would lose typed input.
  closeOnBackdrop?: boolean
  // Names the dialog when there's no visible title.
  "aria-label"?: string
}

// Locks page scroll while any dialog or drawer is open (they can stack).
let scrollLocks = 0
let savedOverflow = ""
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    if (scrollLocks++ === 0) {
      savedOverflow = document.body.style.overflow
      document.body.style.overflow = "hidden"
    }
    return () => {
      if (--scrollLocks === 0) document.body.style.overflow = savedOverflow
    }
  }, [active])
}

// A modal dialog (#144): focus moves in on open and is trapped there, Escape and the
// close button close it, and focus returns to what opened it.
export default function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  size = "medium",
  showCloseButton = true,
  showHeader = true,
  footer,
  role = "dialog",
  initialFocus,
  closeOnBackdrop = true,
  ...aria
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null)
  const id = useStableId("dialog")

  useScrollLock(isOpen)
  useEscape(isOpen, onClose)
  useFocusTrap(ref, isOpen, { initialFocus, preferIn: ".gl-modal__content" })

  if (!isOpen) return null

  const titled = showHeader && title
  return (
    <div
      className="gl-modal-overlay"
      // mousedown, not click: a text selection dragged out of the dialog shouldn't close it.
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={titled ? `${id}-title` : undefined}
        aria-label={titled ? undefined : (aria["aria-label"] ?? title)}
        aria-describedby={description ? `${id}-description` : undefined}
        tabIndex={-1}
        className={`gl-modal gl-modal--${size}${!showHeader ? " gl-modal--no-header" : ""}`}
      >
        {!showHeader && showCloseButton && (
          <IconButton
            className="gl-modal__close-btn gl-modal__close-btn--floating"
            onClick={onClose}
            aria-label="Close"
            icon={<CloseIcon />}
          />
        )}

        {showHeader && (title || showCloseButton) && (
          <div className="gl-modal__header">
            <div className="gl-modal__heading">
              {title && (
                <h2 id={`${id}-title`} className="gl-modal__title">
                  {title}
                </h2>
              )}
              {description && (
                <p id={`${id}-description`} className="gl-modal__description">
                  {description}
                </p>
              )}
            </div>
            {showCloseButton && (
              <IconButton className="gl-modal__close-btn" onClick={onClose} aria-label="Close" icon={<CloseIcon />} />
            )}
          </div>
        )}

        <div className="gl-modal__content">{children}</div>

        {footer && <div className="gl-modal__footer">{footer}</div>}
      </div>
    </div>
  )
}

// The same component under the name the design system uses.
export { Modal as Dialog }
