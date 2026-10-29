import { cloneElement, isValidElement, useRef, useState, type ReactElement, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useEscape, useFloating, useStableId } from "@gl-admin/components/ui/a11y"
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

// A short label shown on hover and on keyboard focus (#144), hidden by Escape.
// Supplements a visible or aria-label name; never the only place information lives.
// It renders into #admin (outside any overflow-hidden parent) and takes the theme of
// the element it describes.
export default function Tooltip({ content, detail, placement = "right", enabled = true, children }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const targetRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const id = useStableId("tooltip")
  const shown = enabled && visible
  const { style } = useFloating(targetRef, tipRef, shown, placement, { gap: 8 })

  useEscape(shown, () => setVisible(false))

  const host = typeof document !== "undefined" ? (document.getElementById("admin") ?? document.body) : null
  const theme = targetRef.current?.closest("[data-theme]")?.getAttribute("data-theme") ?? undefined

  // Point the child at the tooltip when it's a DOM element (custom components may
  // not pass the attribute through).
  const child =
    enabled && isValidElement(children) && typeof children.type === "string"
      ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, { "aria-describedby": shown ? id : undefined })
      : children

  return (
    <>
      <div
        className="gl-tooltip-target"
        ref={targetRef}
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
      >
        {child}
      </div>
      {host &&
        shown &&
        createPortal(
          <div ref={tipRef} id={id} role="tooltip" className="gl-tooltip" data-theme={theme} style={style}>
            <span className="gl-tooltip__label">{content}</span>
            {detail && <span className="gl-tooltip__detail">{detail}</span>}
          </div>,
          host
        )}
    </>
  )
}
