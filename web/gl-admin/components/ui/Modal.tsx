import React, { useEffect } from "react"
import Icon from "@gl-admin/components/ui/Icon"
import "@gl-admin/assets/styles/components/ui/modal.scss"

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  size?: "small" | "medium" | "large" | "fullscreen"
  showCloseButton?: boolean
  showHeader?: boolean
  footer?: React.ReactNode
}

const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  size = "medium",
  showCloseButton = true,
  showHeader = true,
  footer,
}) => {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden"
    } else {
      document.body.style.overflow = "unset"
    }

    return () => {
      document.body.style.overflow = "unset"
    }
  }, [isOpen])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose()
      }
    }

    document.addEventListener("keydown", handleEscape)
    return () => document.removeEventListener("keydown", handleEscape)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="gl-modal-overlay" onClick={onClose}>
      <div
        className={`gl-modal gl-modal--${size}${!showHeader ? " gl-modal--no-header" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {!showHeader && showCloseButton && (
          <button
            className="gl-modal__close-btn gl-modal__close-btn--floating"
            onClick={onClose}
            aria-label="Close modal"
          >
            <Icon name="close" color="#333536" width="20px" height="20px" />
          </button>
        )}

        {showHeader && (title || showCloseButton) && (
          <div className="gl-modal__header">
            {title && <h2 className="gl-modal__title">{title}</h2>}
            {showCloseButton && (
              <button className="gl-modal__close-btn" onClick={onClose} aria-label="Close modal">
                <Icon name="close" color="#333536" width="20px" height="20px" />
              </button>
            )}
          </div>
        )}

        <div className="gl-modal__content">{children}</div>

        {footer && <div className="gl-modal__footer">{footer}</div>}
      </div>
    </div>
  )
}

export default Modal
