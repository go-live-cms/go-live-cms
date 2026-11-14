import { useEffect, useRef } from "react"
import { useLocation } from "react-router-dom"

// How long after a navigation the new page may take to draw its <h1> (lazy pages load
// their code first). After that, <main> gets focus instead.
export const ROUTE_FOCUS_WAIT_MS = 3000

// Focuses an element that isn't a control, for this moment only: tabindex and the
// marker (global.scss draws no ring for it) go on blur, so clicks on page text don't
// focus it later. The skip link (app.tsx) uses it for <main> too.
export function focusOnce(el: HTMLElement) {
  if (!el.hasAttribute("tabindex")) {
    el.tabIndex = -1
    el.addEventListener("blur", () => el.removeAttribute("tabindex"), { once: true })
  }
  el.setAttribute("data-route-focus", "")
  el.addEventListener("blur", () => el.removeAttribute("data-route-focus"), { once: true })
  el.focus()
}

// After a route change (#480, WCAG 2.4.3 / 4.1.3), focus moves to the new page's <h1>,
// or to <main> when the page has none, so a screen reader reads where you are and Tab
// starts from the page, not the sidebar link. Only the path counts (a tab or filter in
// the query string isn't a new page), the first load is left alone, and so is a page
// that put focus somewhere itself (a field with autofocus, a dialog). A heading that is
// replaced while the page loads (a loading state's) hands focus to the new one.
export function useRouteFocus(mainId: string) {
  const { pathname } = useLocation()
  // The path last rendered, and where focus was before the new page rendered (its
  // sidebar link, say): read during render, since the page's own autofocus moves focus
  // before any effect runs. `from` stays null on the first load.
  const rendered = useRef(pathname)
  const from = useRef<{ pathname: string; element: Element | null } | null>(null)
  if (rendered.current !== pathname) {
    rendered.current = pathname
    from.current = { pathname, element: typeof document !== "undefined" ? document.activeElement : null }
  }

  useEffect(() => {
    const navigation = from.current
    if (!navigation || navigation.pathname !== pathname) return // the first load
    const main = document.getElementById(mainId)
    if (!main) return

    // Ours, from this effect's first run (StrictMode runs it twice in dev).
    let focused: HTMLElement | null = main.querySelector<HTMLElement>("[data-route-focus]")
    let stopped = false

    const pageTookFocus = (active: Element | null) =>
      Boolean(
        active &&
          active !== main &&
          active !== navigation.element &&
          (main.contains(active) || active.closest('[aria-modal="true"]'))
      )

    const check = () => {
      if (stopped) return
      const active = document.activeElement
      const lost = !active || active === document.body || !active.isConnected
      if (focused) {
        if (active === focused) return
        // Focus went somewhere else on purpose: done. Our heading was replaced: follow.
        if (!lost) return stop()
      } else if (pageTookFocus(active)) {
        return stop()
      }
      const heading = main.querySelector<HTMLElement>("h1")
      if (heading && heading !== focused) {
        focused = heading
        focusOnce(heading)
      }
    }

    const observer = new MutationObserver(check)
    const fallback = window.setTimeout(() => {
      if (!focused && !pageTookFocus(document.activeElement)) focusOnce(main)
      stop()
    }, ROUTE_FOCUS_WAIT_MS)
    function stop() {
      stopped = true
      observer.disconnect()
      window.clearTimeout(fallback)
    }

    observer.observe(main, { childList: true, subtree: true })
    check()
    return stop
  }, [mainId, pathname])
}