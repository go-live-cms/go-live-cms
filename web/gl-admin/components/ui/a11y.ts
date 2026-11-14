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

// How the user last moved through the page (#480), as `data-input-modality` on <html>:
// "keyboard" after a key, "pointer" after a press or a real mouse move. Lists driven
// by aria-activedescendant (Select, Combobox, the slash/+/@ menus, the palette) keep
// focus in their field, so :focus-visible never reaches the active option; the shared
// menu-row style (mixins.scss) draws the focus ring on it while this says "keyboard",
// and only the hover fill for the mouse. Installed once (AppLayout, and Listbox for
// anything that renders one outside the shell).
let modalityInstalled = false
export function installInputModality(doc: Document = document) {
  if (modalityInstalled || typeof doc === "undefined") return
  modalityInstalled = true
  const root = doc.documentElement
  const set = (value: "keyboard" | "pointer") => {
    if (root.dataset.inputModality !== value) root.dataset.inputModality = value
  }
  set("keyboard")
  doc.addEventListener("keydown", (e) => {
    // A modifier alone (Ctrl before a click) says nothing about the next move.
    if (!["Control", "Shift", "Alt", "Meta"].includes(e.key)) set("keyboard")
  }, true)
  doc.addEventListener("pointerdown", () => set("pointer"), true)
  // Only a move the user made: browsers send synthetic moves (no movement) when the
  // page scrolls under a still pointer, e.g. while the arrows scroll a list.
  doc.addEventListener("mousemove", (e) => {
    if (e.movementX !== 0 || e.movementY !== 0) set("pointer")
  }, true)
}

// Makes everything outside `ref` inert while `active` (#480): Modal and Drawer render
// in place (not portaled), so this walks up from the dialog and marks each ancestor's
// other children. Nested dialogs stack (a count per element), and the old state comes
// back on close. Skipped: anything marked `data-inert-exempt` (the toaster, whose live
// regions must still speak), and anything holding the block editor's ProseMirror view
// (collaboration rules: nothing but the editor touches its DOM; aria-modal and the focus
// trap cover it). Its ancestors' other children are still marked.
const inertCounts = new Map<Element, number>()
export function useInertOthers(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const dialog = ref.current
    if (!active || !dialog) return
    const marked: Element[] = []
    for (let node: Element = dialog; node.parentElement && node !== document.body; node = node.parentElement) {
      for (const sibling of Array.from(node.parentElement.children)) {
        if (sibling === node || sibling.matches("script, style, [data-inert-exempt]")) continue
        if (sibling.matches(".ProseMirror") || sibling.querySelector(".ProseMirror")) continue
        const count = inertCounts.get(sibling) ?? 0
        if (count === 0) {
          if (sibling.hasAttribute("inert")) continue // inert on its own: not ours to undo
          sibling.setAttribute("inert", "")
        }
        inertCounts.set(sibling, count + 1)
        marked.push(sibling)
      }
    }
    return () => {
      for (const el of marked) {
        const count = (inertCounts.get(el) ?? 1) - 1
        if (count > 0) {
          inertCounts.set(el, count)
        } else {
          inertCounts.delete(el)
          el.removeAttribute("inert")
        }
      }
    }
  }, [ref, active])
}

// After a submit that fails (#479, WCAG 3.3.1): focus moves to the first field the form
// marks invalid, whose error is read with it (aria-describedby). One listener for every
// admin form (installed by AppLayout): it watches the submitted form for a while, so an
// error the API sends back later counts too. It doesn't take focus from somewhere else:
// only from the form, its submit button (a dialog's footer, `form=`) or nowhere (a
// disabled button dropped it), and not when focus is already on an invalid field.
export const SUBMIT_FOCUS_WATCH_MS = 5000
const INVALID = '[aria-invalid="true"]:not([disabled])'

export function focusFirstInvalid(form: HTMLFormElement): boolean {
  const first = form.querySelector<HTMLElement>(INVALID)
  if (!first) return false
  const active = form.ownerDocument.activeElement as HTMLElement | null
  if (active && form.contains(active) && active.matches(INVALID)) return true
  const fromHere =
    !active || active === form.ownerDocument.body || form.contains(active) || (active as HTMLButtonElement).form === form
  if (fromHere) first.focus()
  return true
}

let submitFocusInstalled = false
export function installSubmitFocus(doc: Document = document) {
  if (submitFocusInstalled) return
  submitFocusInstalled = true
  doc.addEventListener(
    "submit",
    (e) => {
      const form = e.target
      if (!(form instanceof HTMLFormElement)) return
      const observer = new MutationObserver(() => focusFirstInvalid(form) && stop())
      const timer = setTimeout(() => stop(), SUBMIT_FOCUS_WATCH_MS)
      function stop() {
        observer.disconnect()
        clearTimeout(timer)
      }
      observer.observe(form, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-invalid"] })
      // Errors React draws in the same task as the submit.
      requestAnimationFrame(() => focusFirstInvalid(form) && stop())
    },
    true
  )
}

// A stable id for aria wiring, with a readable prefix; `given` wins.
export function useStableId(prefix: string, given?: string): string {
  const id = useReactId()
  return given ?? `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`
}
