import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react"
import { CheckIcon, CloseIcon, DangerIcon, InfoIcon, WarningIcon } from "@gl-admin/components/ui/icons"
import "@gl-admin/assets/styles/components/ui/toast.scss"

// Toasts (#338): short, inverted confirmations at the bottom of the screen. One store
// for the whole admin; <Toaster /> (mounted once in app.tsx) draws it. Call
// `toast.success("Post published")` from anywhere.

export type ToastType = "success" | "error" | "warning" | "info"

export type ToastItem = {
  id: string
  type: ToastType
  message: ReactNode
  // An action next to the message ("View post", "Undo").
  action?: { label: string; onClick: () => void }
  // ms before it hides itself; errors stay until dismissed when this is Infinity.
  duration: number
}

type ToastOptions = { duration?: number; action?: ToastItem["action"] }

let items: ToastItem[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
let counter = 0

export function dismissToast(id: string) {
  items = items.filter((t) => t.id !== id)
  emit()
}

function show(type: ToastType, message: ReactNode, options: ToastOptions = {}): string {
  const id = `toast-${++counter}`
  const duration = options.duration ?? (type === "error" ? 6000 : 4000)
  // At most three at once; the oldest goes first.
  items = [...items, { id, type, message, action: options.action, duration }].slice(-3)
  emit()
  return id
}

export const toast = {
  success: (message: ReactNode, options?: ToastOptions) => show("success", message, options),
  error: (message: ReactNode, options?: ToastOptions) => show("error", message, options),
  warning: (message: ReactNode, options?: ToastOptions) => show("warning", message, options),
  info: (message: ReactNode, options?: ToastOptions) => show("info", message, options),
  dismiss: dismissToast,
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(subscribe, () => items, () => items)
}

const ICONS: Record<ToastType, ReactNode> = {
  success: <CheckIcon />,
  error: <DangerIcon />,
  warning: <WarningIcon />,
  info: <InfoIcon />,
}

export function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const start = () => {
    if (Number.isFinite(item.duration)) timer.current = setTimeout(onDismiss, item.duration)
  }
  const stop = () => clearTimeout(timer.current)

  // Hovering or focusing a toast pauses its timer, so it can be read and acted on.
  useEffect(() => {
    start()
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])

  return (
    <div
      className={`gl-toast gl-toast--${item.type}`}
      onMouseEnter={stop}
      onMouseLeave={start}
      onFocus={stop}
      onBlur={start}
    >
      <span className="gl-toast__icon">{ICONS[item.type]}</span>
      <span className="gl-toast__message">{item.message}</span>
      {item.action && (
        <button
          type="button"
          className="gl-toast__action"
          onClick={() => {
            item.action?.onClick()
            onDismiss()
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className="gl-toast__close" aria-label="Dismiss" onClick={onDismiss}>
        <CloseIcon size={14} />
      </button>
    </div>
  )
}

// Two live regions: errors interrupt (alert), everything else waits its turn (status).
export function Toaster() {
  const all = useToasts()
  const errors = all.filter((t) => t.type === "error")
  const others = all.filter((t) => t.type !== "error")

  return (
    <div className="gl-toaster">
      <div role="status" aria-live="polite" className="gl-toaster__region">
        {others.map((t) => (
          <ToastView key={t.id} item={t} onDismiss={() => dismissToast(t.id)} />
        ))}
      </div>
      <div role="alert" aria-live="assertive" className="gl-toaster__region">
        {errors.map((t) => (
          <ToastView key={t.id} item={t} onDismiss={() => dismissToast(t.id)} />
        ))}
      </div>
    </div>
  )
}
