import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react"
import { CheckIcon, CloseIcon, DangerIcon, InfoIcon, WarningIcon } from "@gl-admin/components/ui/icons"
import "@gl-admin/assets/styles/components/ui/toast.scss"

// Toasts (#338): short, inverted confirmations at the bottom of the screen. One store
// for the whole admin; <Toaster /> (mounted once in app.tsx) draws it. Call
// `toast.success("Post published")` from anywhere.
//
// Timing (#479, WCAG 2.2.1): errors and toasts with an action ("Undo", "View post") stay
// until dismissed, whatever `duration` says; the rest hide after theirs, paused while
// hovered or focused. F6 (TOASTER_SHORTCUT) moves focus to the newest toast and back.

export type ToastType = "success" | "error" | "warning" | "info"

export type ToastItem = {
  id: string
  type: ToastType
  message: ReactNode
  // An action next to the message ("View post", "Undo").
  action?: { label: string; onClick: () => void }
  // ms before it hides itself; Infinity: until dismissed.
  duration: number
}

type ToastOptions = { duration?: number; action?: ToastItem["action"] }

// The key that reaches the toaster. Not taken elsewhere: Ctrl K is the palette (the link
// dialog in the editor), Alt F10 the editor's toolbars; browsers use F6 to cycle their
// own panes only when the page doesn't, and it's only claimed while a toast shows.
export const TOASTER_SHORTCUT = "F6"

const MAX_TOASTS = 3

let items: ToastItem[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
let counter = 0

export function dismissToast(id: string) {
  items = items.filter((t) => t.id !== id)
  emit()
}

// Whether a toast waits for the user: errors and anything with an action.
export function staysUntilDismissed(item: Pick<ToastItem, "type" | "action">): boolean {
  return item.type === "error" || Boolean(item.action)
}

export function toastDuration(type: ToastType, options: ToastOptions = {}): number {
  if (staysUntilDismissed({ type, action: options.action })) return Infinity
  return options.duration ?? 4000
}

function show(type: ToastType, message: ReactNode, options: ToastOptions = {}): string {
  const id = `toast-${++counter}`
  const next = [...items, { id, type, message, action: options.action, duration: toastDuration(type, options) }]
  // At most three at once. The oldest that would hide on its own goes first, so a
  // burst of confirmations never pushes out an error or an Undo; then the oldest.
  while (next.length > MAX_TOASTS) {
    const timed = next.findIndex((t) => Number.isFinite(t.duration))
    next.splice(timed >= 0 ? timed : 0, 1)
  }
  items = next
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
  // Hovering or focusing a toast pauses its timer, so it can be read and acted on. It
  // restarts only once neither holds it.
  const holds = useRef({ hover: false, focus: false })
  const sync = () => {
    clearTimeout(timer.current)
    const { hover, focus } = holds.current
    if (!hover && !focus && Number.isFinite(item.duration)) timer.current = setTimeout(onDismiss, item.duration)
  }
  const hold = (which: "hover" | "focus", on: boolean) => {
    holds.current[which] = on
    sync()
  }

  useEffect(() => {
    sync()
    return () => clearTimeout(timer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])

  return (
    <div
      className={`gl-toast gl-toast--${item.type}`}
      data-toast-id={item.id}
      onMouseEnter={() => hold("hover", true)}
      onMouseLeave={() => hold("hover", false)}
      onFocus={() => hold("focus", true)}
      onBlur={(e) => {
        // Moving between the toast's own buttons keeps it held.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hold("focus", false)
      }}
    >
      <span className="gl-toast__icon">{ICONS[item.type]}</span>
      <span className="gl-toast__message">
        {item.message}
        {/* Read with the toast, so a screen reader user knows the action can be reached. */}
        {item.action && <span className="gl-visually-hidden"> Press {TOASTER_SHORTCUT} to go to it.</span>}
      </span>
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
// The toaster is outside <main> and exempt from dialogs' inert (a11y.ts), so its
// regions speak and F6 reaches it while a dialog is open.
export function Toaster() {
  const all = useToasts()
  const errors = all.filter((t) => t.type === "error")
  const others = all.filter((t) => t.type !== "error")
  const ref = useRef<HTMLDivElement>(null)
  // Where F6 came from, to go back to on the next F6 or when the focused toast goes.
  const returnTo = useRef<HTMLElement | null>(null)
  const hasToasts = all.length > 0

  useEffect(() => {
    if (!hasToasts) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== TOASTER_SHORTCUT || e.ctrlKey || e.altKey || e.metaKey) return
      const root = ref.current
      if (!root) return
      e.preventDefault()
      if (root.contains(document.activeElement)) {
        const back = returnTo.current
        returnTo.current = null
        if (back && document.contains(back)) back.focus()
        return
      }
      // The newest toast (ids count up), whichever region draws it.
      const order = (el: HTMLElement) => Number(el.dataset.toastId?.replace("toast-", "") ?? 0)
      const newest = Array.from(root.querySelectorAll<HTMLElement>(".gl-toast")).sort((a, b) => order(a) - order(b)).pop()
      const target = newest?.querySelector<HTMLElement>("button")
      if (!target) return
      returnTo.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
      target.focus()
    }
    // A press elsewhere means the user moved on: don't pull focus back later.
    const onPointerDown = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) returnTo.current = null
    }
    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("pointerdown", onPointerDown, true)
    }
  }, [hasToasts])

  // The focused toast was dismissed (or acted on): focus would drop to <body>. Go back.
  useEffect(() => {
    const active = document.activeElement
    if (active && active !== document.body && document.contains(active)) return
    const back = returnTo.current
    if (!back) return
    returnTo.current = null
    if (document.contains(back)) back.focus()
  }, [all])

  return (
    <div
      ref={ref}
      className="gl-toaster"
      data-inert-exempt=""
      onBlur={(e) => {
        // Tabbed out of the toaster to somewhere else: nothing to go back to.
        const to = e.relatedTarget as Node | null
        if (to && !e.currentTarget.contains(to)) returnTo.current = null
      }}
    >
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
