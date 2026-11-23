import { act, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { usePresence } from "./presence"

// `animated`: the closing element gets an inline exit animation, which jsdom's
// getComputedStyle reports (it computes none from stylesheets).
function Panel({ open, animated }: { open: boolean; animated: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const { mounted, closing } = usePresence(open, ref)
  if (!mounted) return null
  return (
    <div ref={ref} id="panel" className={closing ? "is-closing" : ""} style={closing && animated ? { animationName: "out", animationDuration: "150ms" } : undefined}>
      <span id="child" />
    </div>
  )
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const show = (open: boolean, animated: boolean) => act(() => root.render(<Panel open={open} animated={animated} />))
const panel = () => document.getElementById("panel")
const animationEnd = (el: Element | null) => act(() => void el?.dispatchEvent(new Event("animationend", { bubbles: true })))

describe("usePresence (#551)", () => {
  it("unmounts at once when nothing animates (reduced motion, tests)", () => {
    show(true, false)
    show(false, false)
    expect(panel()).toBeNull()
  })

  it("stays mounted, closing, until its own exit animation ends", () => {
    show(true, true)
    show(false, true)
    expect(panel()?.className).toBe("is-closing")
    // A child's animation ending doesn't count.
    animationEnd(document.getElementById("child"))
    expect(panel()).not.toBeNull()
    animationEnd(panel())
    expect(panel()).toBeNull()
  })

  it("reopening while closing keeps it open", () => {
    show(true, true)
    show(false, true)
    show(true, true)
    expect(panel()?.className).toBe("")
  })

  it("never stays mounted when the end event doesn't come", () => {
    vi.useFakeTimers()
    try {
      show(true, true)
      show(false, true)
      act(() => void vi.advanceTimersByTime(1000))
      expect(panel()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
