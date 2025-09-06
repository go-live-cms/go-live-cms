import React, { useEffect, useState } from "react"

export interface ToastMessage {
  id: string
  type: "success" | "error" | "warning" | "info"
  message: string
  duration?: number
}

interface ToastProps {
  message: ToastMessage
  onClose: (id: string) => void
}

export const Toast: React.FC<ToastProps> = ({ message, onClose }) => {
  const [isVisible, setIsVisible] = useState(false)
  const [isExiting, setIsExiting] = useState(false)

  useEffect(() => {
    const showTimer = setTimeout(() => setIsVisible(true), 100)

    const hideTimer = setTimeout(() => {
      setIsExiting(true)
      setTimeout(() => onClose(message.id), 300)
    }, message.duration || 3000)

    return () => {
      clearTimeout(showTimer)
      clearTimeout(hideTimer)
    }
  }, [message, onClose])

  const getToastTypeClass = () => {
    switch (message.type) {
      case "success":
        return "toast--success"
      case "error":
        return "toast--error"
      case "warning":
        return "toast--warning"
      default:
        return "toast--info"
    }
  }

  return (
    <div
      className={`toast ${getToastTypeClass()} ${isVisible ? "toast--visible" : ""} ${
        isExiting ? "toast--exiting" : ""
      }`}
      role="alert"
      aria-live="polite"
    >
      <div className="toast__content">
        <span className="toast__message">{message.message}</span>
        <button className="toast__close" onClick={() => onClose(message.id)} aria-label="Close notification">
          ×
        </button>
      </div>
    </div>
  )
}

interface ToastContainerProps {
  toasts: ToastMessage[]
  onRemoveToast: (id: string) => void
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onRemoveToast }) => {
  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <Toast key={toast.id} message={toast} onClose={onRemoveToast} />
      ))}
    </div>
  )
}

export const useToast = () => {
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const showToast = (type: ToastMessage["type"], message: string, duration?: number) => {
    const id = Math.random().toString(36).substring(2, 9)
    const toast: ToastMessage = { id, type, message, duration }

    setToasts((prev) => [...prev, toast])
    return id
  }

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }

  const showSuccess = (message: string, duration?: number) => showToast("success", message, duration)
  const showError = (message: string, duration?: number) => showToast("error", message, duration)
  const showWarning = (message: string, duration?: number) => showToast("warning", message, duration)
  const showInfo = (message: string, duration?: number) => showToast("info", message, duration)

  return {
    toasts,
    showToast,
    showSuccess,
    showError,
    showWarning,
    showInfo,
    removeToast,
  }
}
