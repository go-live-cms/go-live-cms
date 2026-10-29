import { useEffect, useId as useReactId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react"
import { autoUpdate, computePosition, flip, offset, shift, size, type Placement } from "@floating-ui/dom"

// Keyboard and focus helpers shared by the UI components (#338, patterns from #144):
// focus traps for dialogs and drawers, roving focus for menus and tabs, Escape to
// close, and positioning for anything that floats next to its trigger.

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",")

// Elements Tab can reach inside `container`, in document order.
export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("inert") && !el.closest("[hidden],[inert]") && el.getAttribute("aria-hidden") !== "true"
  )
}

// The index arrow keys move to in a list of `count` items, or null for other keys.
// Wraps at both ends; Home and End jump to the first and last.
export function nextRovingIndex(
  key: string,
  index: number,
  count: number,
  orientation: "horizontal" | "vertical" = "vertical"
): number | null {
  if (count === 0) return null
  const prev = orientation === "vertical" ? "ArrowUp" : "ArrowLeft"
  const next = orientation === "vertical" ? "ArrowDown" : "ArrowRight"
  switch (key) {
    case next:
      return index < 0 ? 0 : (index + 1) % count
    case prev:
      return index < 0 ? count - 1 : (index - 1 + count) % count
    case "Home":
      return 0
    case "End":
      return count - 1
    default:
      return null
  }
}

// Index of the next item whose label starts with `char` (typeahead), after `from`.
export function typeaheadIndex(labels: string[], char: string, from: number): number | null {
  const c = char.toLowerCase()
  if (c.length !== 1 || c === " ") return null
  for (let step = 1; step <= labels.length; step++) {
    const i = (from + step) % labels.length
    if (labels[i]?.trim().toLowerCase().startsWith(c)) return i
  }
  return null
}

// Keeps Tab inside `ref` while `active`, focuses into it on open and gives focus back
// to whatever had it on close. `initialFocus` picks the first element to focus; an
// element that took focus itself (autoFocus) keeps it; otherwise the first focusable
// one in `preferIn` (a selector, e.g. the dialog body, so the close button isn't
// first), then in the container, then the container itself (it needs tabIndex -1).
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  { initialFocus, preferIn }: { initialFocus?: RefObject<HTMLElement | null>; preferIn?: string } = {}
) {
  // Read during render, before children mount: an autoFocus child would already
  // have moved focus by the time any effect runs.
  const opener = useRef<HTMLElement | null>(null)
  const wasActive = useRef(false)
  if (active && !wasActive.current && typeof document !== "undefined") {
    opener.current = document.activeElement as HTMLElement | null
  }
  wasActive.current = active

  useEffect(() => {
    const container = ref.current
    if (!active || !container) return
    const previous = opener.current

    if (initialFocus?.current) {
      initialFocus.current.focus()
    } else if (!container.contains(document.activeElement)) {
      const preferred = preferIn ? container.querySelector<HTMLElement>(preferIn) : null
      ;((preferred && getFocusable(preferred)[0]) ?? getFocusable(container)[0] ?? container).focus()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return
      const items = getFocusable(container)
      if (items.length === 0) {
        e.preventDefault()
        container.focus()
        return
      }
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      const current = document.activeElement
      if (e.shiftKey && (current === firstItem || !container.contains(current))) {
        e.preventDefault()
        lastItem.focus()
      } else if (!e.shiftKey && (current === lastItem || !container.contains(current))) {
        e.preventDefault()
        firstItem.focus()
      }
    }

    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      if (previous && document.contains(previous)) previous.focus()
    }
    // initialFocus is a ref: reading it when the trap starts is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ref])
}

// Calls `onEscape` when Escape is pressed anywhere while `active`. Only the most
// recently opened layer handles it, so Escape in a menu inside a dialog closes the
// menu, not the dialog.
const escapeStack: symbol[] = []

export function useEscape(active: boolean, onEscape: () => void) {
  const handler = useRef(onEscape)
  handler.current = onEscape

  useEffect(() => {
    if (!active) return
    const id = Symbol("layer")
    escapeStack.push(id)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || escapeStack[escapeStack.length - 1] !== id) return
      e.preventDefault()
      e.stopPropagation()
      handler.current()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      const i = escapeStack.lastIndexOf(id)
      if (i >= 0) escapeStack.splice(i, 1)
    }
  }, [active])
}

// Calls `onOutside` on a pointer press outside every element in `refs` while `active`.
export function useClickOutside(
  refs: RefObject<HTMLElement | null>[],
  active: boolean,
  onOutside: () => void
) {
  const handler = useRef(onOutside)
  handler.current = onOutside

  useEffect(() => {
    if (!active) return
    const onPointerDown = (e: PointerEvent | MouseEvent) => {
      const target = e.target as Node
      if (refs.some((r) => r.current?.contains(target))) return
      handler.current()
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
}

// Positions `floating` next to `anchor` while `open` (fixed strategy, so it escapes
// scrolling and overflow-hidden parents), flipping and shifting to stay on screen.
// `matchWidth` makes it at least as wide as the anchor (selects, comboboxes).
export function useFloating(
  anchor: RefObject<HTMLElement | null>,
  floating: RefObject<HTMLElement | null>,
  open: boolean,
  placement: Placement = "bottom-start",
  { gap = 4, matchWidth = false }: { gap?: number; matchWidth?: boolean } = {}
): { style: CSSProperties; placement: Placement; ready: boolean } {
  const [state, setState] = useState<{ x: number; y: number; placement: Placement } | null>(null)

  useLayoutEffect(() => {
    const a = anchor.current
    const f = floating.current
    if (!open || !a || !f) {
      setState(null)
      return
    }
    const update = () =>
      computePosition(a, f, {
        placement,
        strategy: "fixed",
        middleware: [
          offset(gap),
          flip({ padding: 8 }),
          shift({ padding: 8 }),
          ...(matchWidth
            ? [size({ apply: ({ rects }) => void (f.style.minWidth = `${rects.reference.width}px`) })]
            : []),
        ],
      }).then(({ x, y, placement }) => setState({ x, y, placement }))

    return autoUpdate(a, f, update, {
      // jsdom (tests) has neither observer.
      elementResize: typeof ResizeObserver !== "undefined",
      layoutShift: typeof IntersectionObserver !== "undefined",
    })
  }, [anchor, floating, open, placement, gap, matchWidth])

  return {
    // Transparent until the first position lands, so it never flashes at 0,0. Not
    // `visibility: hidden`: global.scss transitions every property, and children would
    // keep an inherited, still-transitioning hidden (unfocusable) after it's placed. No
    // transition on it either, or it would slide in from 0,0.
    style: state
      ? { position: "fixed", left: state.x, top: state.y, transition: "none" }
      : { position: "fixed", left: 0, top: 0, opacity: 0, pointerEvents: "none", transition: "none" },
    placement: state?.placement ?? placement,
    // Positioned: focus can move into it now.
    ready: state !== null,
  }
}

// A stable id for aria wiring, with a readable prefix; `given` wins.
export function useStableId(prefix: string, given?: string): string {
  const id = useReactId()
  return given ?? `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`
}
