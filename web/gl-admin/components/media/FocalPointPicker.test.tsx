import { describe, expect, it } from "vitest"
import { focalPointFromClick, formatFocalPoint, nudgeFocalPoint } from "./FocalPointPicker"

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
