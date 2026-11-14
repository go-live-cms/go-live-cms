import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { getFocusable, useEscape, useFloating, useStableId } from "@gl-admin/components/ui/a11y"
import "@gl-admin/assets/styles/components/ui/tooltip.scss"

type Placement = "top" | "bottom" | "left" | "right"

interface TooltipProps {
  content: ReactNode
  // A second, dimmer line ("Editing · Click to jump to cursor").
  detail?: ReactNode
  placement?: Placement
  enabled?: boolean
  children: ReactElement
}

// How long the tooltip waits after the pointer leaves the target or the tooltip, so
// the pointer can cross the 8px gap onto it (WCAG 1.4.13: hoverable).
export const TOOLTIP_HIDE_DELAY_MS = 120

// The words of a node, for comparing a tooltip with the name it would repeat.
const words = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase()

// A short label shown on hover and on keyboard focus (#144), hidden by Escape. The
// pointer can move onto it without it closing (#479). Supplements a visible or
// aria-label name; never the only place information lives. It renders into #admin
// (outside any overflow-hidden parent) and takes the theme of the element it describes.
//
// The element it describes is the target's first focusable element (or its first
// element), whatever renders it: it gets aria-describedby pointing at the text, which
// is always in the DOM (hidden while the tooltip isn't shown), so the description is
// there when focus arrives. Not when the text only repeats the element's name.
export default function Tooltip({ content, detail, placement = "right", enabled = true, children }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const targetRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const id = useStableId("tooltip")
  const shown = enabled && visible
  const { style } = useFloating(targetRef, tipRef, shown, placement, { gap: 8 })

  useEscape(shown, () => setVisible(false))

  const show = () => {
    clearTimeout(hideTimer.current)
    setVisible(true)
  }
  const hideSoon = () => {
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setVisible(false), TOOLTIP_HIDE_DELAY_MS)
  }
  useEffect(() => () => clearTimeout(hideTimer.current), [])

  // aria-describedby on the described element, added to what it already has.
  useEffect(() => {
    const target = targetRef.current
    if (!enabled || !target) return
    // Never the description span itself (a child that renders no element).
    const first = target.firstElementChild === textRef.current ? null : target.firstElementChild
    const el = getFocusable(target)[0] ?? first
    if (!el || !(el instanceof HTMLElement)) return
    const name = el.getAttribute("aria-label") ?? el.textContent
    if (!detail && words(textRef.current?.textContent ?? tipRef.current?.textContent) === words(name)) return
    const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
    if (ids.includes(id)) return
    el.setAttribute("aria-describedby", [...ids, id].join(" "))
    return () => {
      const rest = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((x) => x && x !== id)
      if (rest.length) el.setAttribute("aria-describedby", rest.join(" "))
      else el.removeAttribute("aria-describedby")
    }
    // Not on `content` / `detail`: usually new JSX each render. The description span
    // follows them; only whether they repeat the name is decided here, once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, id])

  const host = typeof document !== "undefined" ? (document.getElementById("admin") ?? document.body) : null
  const theme = targetRef.current?.closest("[data-theme]")?.getAttribute("data-theme") ?? undefined

  return (
    <>
      <div
        className="gl-tooltip-target"
        ref={targetRef}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={() => setVisible(false)}
      >
        {children}
        {/* The description while the tooltip isn't shown (one element has the id). */}
        {enabled && !shown && (
          <span ref={textRef} id={id} hidden>
            {content}
            {detail ? <> {detail}</> : null}
          </span>
        )}
      </div>
      {host &&
        shown &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className="gl-tooltip"
            data-theme={theme}
            style={style}
            onMouseEnter={show}
            onMouseLeave={hideSoon}
          >
            <span className="gl-tooltip__label">{content}</span>
            {detail && <span className="gl-tooltip__detail">{detail}</span>}
          </div>,
          host
        )}
    </>
  )
}
