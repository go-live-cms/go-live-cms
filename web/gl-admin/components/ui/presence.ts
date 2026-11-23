import { useLayoutEffect, useState, type RefObject } from "react"

// Exit animations (#551). Keeps an overlay mounted after it closes while its `.is-closing`
// CSS animation plays on `ref`'s element, then unmounts it. With nothing to wait for it
// unmounts at once: reduced motion turns the motion tokens to 0ms (_tokens.scss), and
// jsdom computes no animation. A reopen while closing just stays open.
export function usePresence(open: boolean, ref: RefObject<HTMLElement | null>): { mounted: boolean; closing: boolean } {
  const [wasOpen, setWasOpen] = useState(open)
  const [leaving, setLeaving] = useState(false)
  // Adjusting state on a prop change, during render (React's documented pattern).
  if (open !== wasOpen) {
    setWasOpen(open)
    setLeaving(!open)
  }

  useLayoutEffect(() => {
    if (!leaving) return
    const el = ref.current
    if (!el || !playsAnimation(el)) {
      setLeaving(false)
      return
    }
    // Its own animation only: a child's ending (a button's spinner) doesn't count.
    const done = (e?: Event) => {
      if (!e || e.target === el) setLeaving(false)
    }
    el.addEventListener("animationend", done)
    el.addEventListener("animationcancel", done)
    // Never stuck mounted if the event doesn't come (a tab in the background).
    const fallback = setTimeout(done, 1000)
    return () => {
      el.removeEventListener("animationend", done)
      el.removeEventListener("animationcancel", done)
      clearTimeout(fallback)
    }
  }, [leaving, ref])

  return { mounted: open || leaving, closing: !open && leaving }
}

// A one-off fade-in of an element that stays mounted (#551: the page on a route change).
// Timed by a motion token, so reduced motion (0ms) skips it; jsdom has no `animate`.
export function fadeIn(el: HTMLElement | null, token = "--duration-base") {
  if (!el || typeof el.animate !== "function") return
  const style = getComputedStyle(el)
  const duration = parseFloat(style.getPropertyValue(token))
  if (!(duration > 0)) return
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: style.getPropertyValue("--ease-out").trim() || "ease-out" })
}

export function playsAnimation(el: Element): boolean {
  const style = getComputedStyle(el)
  const name = style.animationName
  return !!name && name !== "none" && (style.animationDuration || "0s").split(",").some((d) => parseFloat(d) > 0)
}
