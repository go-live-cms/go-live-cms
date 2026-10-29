import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react"
import type { Placement } from "@floating-ui/dom"
import { getFocusable, useClickOutside, useEscape, useFloating, useStableId } from "@gl-admin/components/ui/a11y"
import type { TriggerProps } from "@gl-admin/components/ui/Menu"
import "@gl-admin/assets/styles/components/ui/menu.scss"

type PopoverProps = {
  trigger: (props: TriggerProps) => ReactElement
  // A heading inside the popover, which also names it for screen readers.
  title?: ReactNode
  // Names it when there's no title.
  label?: string
  // Content, or a function that gets `close` (for a "Done" button).
  children: ReactNode | ((close: () => void) => ReactNode)
  placement?: Placement
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}

// A non-modal panel next to its trigger (filters, quick settings). Opening moves focus
// into it; Escape closes and returns focus to the trigger; clicking outside or
// tabbing out of it closes it.
export default function Popover({
  trigger,
  title,
  label,
  children,
  placement = "bottom-start",
  open: controlled,
  onOpenChange,
  className = "",
}: PopoverProps) {
  const [uncontrolled, setUncontrolled] = useState(false)
  const open = controlled ?? uncontrolled
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const id = useStableId("popover")
  const { style, ready } = useFloating(triggerRef, panelRef, open, placement, { gap: 6 })

  const setOpen = useCallback(
    (next: boolean) => {
      if (controlled === undefined) setUncontrolled(next)
      onOpenChange?.(next)
    },
    [controlled, onOpenChange]
  )
  const close = useCallback(
    (refocus = true) => {
      setOpen(false)
      if (refocus) triggerRef.current?.focus()
    },
    [setOpen]
  )

  useEscape(open, () => close(true))
  useClickOutside([triggerRef, panelRef], open, () => close(false))

  useEffect(() => {
    const panel = panelRef.current
    if (!open || !ready || !panel) return
    ;(getFocusable(panel)[0] ?? panel).focus()
  }, [open, ready])

  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: () => setOpen(!open),
        onKeyDown: () => {},
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        "aria-controls": open ? id : undefined,
      })}
      {open && (
        <div
          ref={panelRef}
          id={id}
          role="dialog"
          aria-labelledby={title ? `${id}-title` : undefined}
          aria-label={title ? undefined : label}
          tabIndex={-1}
          className={`gl-popover ${className}`}
          style={style}
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null
            if (to && !panelRef.current?.contains(to) && !triggerRef.current?.contains(to)) close(false)
          }}
        >
          {title && (
            <h2 id={`${id}-title`} className="gl-popover__title">
              {title}
            </h2>
          )}
          {typeof children === "function" ? children(() => close(true)) : children}
        </div>
      )}
    </>
  )
}
