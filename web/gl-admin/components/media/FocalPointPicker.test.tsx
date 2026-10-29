import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { FocalPoint } from "@gl-admin/lib/types"
import FocalPointPicker, { FocalCropPreviews, focalPointFromClick, formatFocalPoint, nudgeFocalPoint } from "./FocalPointPicker"

describe("focalPointFromClick", () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 }

  it("maps a click to fractions of the image box", () => {
    expect(focalPointFromClick(rect, 200, 100)).toEqual({ x: 0.25, y: 0.25 })
    expect(focalPointFromClick(rect, 300, 150)).toEqual({ x: 0.5, y: 0.5 })
  })

  it("clamps to 0..1 and rounds to 3 decimals", () => {
    expect(focalPointFromClick(rect, 0, 1000)).toEqual({ x: 0, y: 1 })
    expect(focalPointFromClick(rect, 233, 50)).toEqual({ x: 0.333, y: 0 })
  })

  it("centers on an empty box", () => {
    expect(focalPointFromClick({ left: 0, top: 0, width: 0, height: 0 }, 5, 5)).toEqual({ x: 0.5, y: 0.5 })
  })
})

describe("nudgeFocalPoint", () => {
  it("moves by the step from the current point, or from the center", () => {
    expect(nudgeFocalPoint({ x: 0.5, y: 0.5 }, "ArrowRight")).toEqual({ x: 0.55, y: 0.5 })
    expect(nudgeFocalPoint(null, "ArrowUp")).toEqual({ x: 0.5, y: 0.45 })
    expect(nudgeFocalPoint({ x: 0.02, y: 0.99 }, "ArrowLeft")).toEqual({ x: 0, y: 0.99 })
    expect(nudgeFocalPoint({ x: 0.02, y: 0.99 }, "ArrowDown")).toEqual({ x: 0.02, y: 1 })
  })

  it("ignores other keys", () => {
    expect(nudgeFocalPoint({ x: 0.5, y: 0.5 }, "Enter")).toBeNull()
  })
})

describe("formatFocalPoint", () => {
  it("shows percentages, or that it is unset", () => {
    expect(formatFocalPoint({ x: 0.333, y: 1 })).toBe("33% × 100%")
    expect(formatFocalPoint(null)).toBe("Not set (center)")
  })
})

// The picker itself (#342): arrow keys move the point and it stays inside the image.
describe("FocalPointPicker keyboard control", () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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

  // A controlled picker, like the detail page: each change is fed back as the value.
  function Harness({ initial, onChange }: { initial: FocalPoint | null; onChange: (p: FocalPoint) => void }) {
    const [value, setValue] = useState(initial)
    return (
      <FocalPointPicker
        src="/x.jpg"
        alt=""
        value={value}
        onChange={(p) => {
          setValue(p)
          onChange(p)
        }}
      />
    )
  }

  const press = (key: string, times = 1) => {
    const picker = container.querySelector("[data-testid=focal-point-picker]")!
    for (let i = 0; i < times; i++) {
      act(() => {
        picker.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
      })
    }
  }

  it("moves the point with the arrow keys and announces it", () => {
    const seen: FocalPoint[] = []
    act(() => root.render(<Harness initial={{ x: 0.5, y: 0.5 }} onChange={(p) => seen.push(p)} />))
    press("ArrowRight")
    press("ArrowDown", 2)
    expect(seen.at(-1)).toEqual({ x: 0.55, y: 0.6 })
    const picker = container.querySelector("[data-testid=focal-point-picker]")!
    expect(picker.getAttribute("tabindex")).toBe("0")
    expect(picker.getAttribute("aria-label")).toContain("55% × 60%")
    const marker = container.querySelector<HTMLElement>(".focal-point-picker__marker")!
    expect(parseFloat(marker.style.left)).toBeCloseTo(55)
    expect(parseFloat(marker.style.top)).toBeCloseTo(60)
  })

  it("clamps to 0..1 at every edge", () => {
    const seen: FocalPoint[] = []
    act(() => root.render(<Harness initial={{ x: 0.9, y: 0.1 }} onChange={(p) => seen.push(p)} />))
    press("ArrowRight", 5)
    press("ArrowUp", 5)
    expect(seen.at(-1)).toEqual({ x: 1, y: 0 })
    press("ArrowLeft", 30)
    press("ArrowDown", 30)
    expect(seen.at(-1)).toEqual({ x: 0, y: 1 })
    for (const p of seen) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(1)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(1)
    }
  })

  it("starts from the center when unset, and ignores other keys", () => {
    const seen: FocalPoint[] = []
    act(() => root.render(<Harness initial={null} onChange={(p) => seen.push(p)} />))
    press("Enter")
    press("a")
    expect(seen).toEqual([])
    press("ArrowLeft")
    expect(seen).toEqual([{ x: 0.45, y: 0.5 }])
  })

  it("is read-only without onChange", () => {
    act(() => root.render(<FocalPointPicker src="/x.jpg" alt="" value={{ x: 0.2, y: 0.3 }} />))
    const picker = container.querySelector("[data-testid=focal-point-picker]")!
    expect(picker.hasAttribute("tabindex")).toBe(false)
    expect(picker.getAttribute("role")).toBeNull()
  })

  it("crops the previews with the same object-position as the site", () => {
    act(() => root.render(<FocalCropPreviews src="/x.jpg" value={{ x: 0.29, y: 0.6 }} />))
    const crops = container.querySelectorAll<HTMLImageElement>(".focal-crops__image")
    expect(crops).toHaveLength(3)
    for (const img of crops) expect(img.style.objectPosition).toBe("29% 60%")
  })
})
