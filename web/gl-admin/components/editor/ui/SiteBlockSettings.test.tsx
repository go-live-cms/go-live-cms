import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WidthField } from "./SiteBlockSettings"

// The site logo's Width in the Block tab (#488): typed freely, stored once, clamped then.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("WidthField", () => {
  it("doesn't clamp while typing: 120 is stored as 120, once, on Enter", () => {
    const onCommit = vi.fn()
    act(() => root.render(<WidthField id="w" width={48} onCommit={onCommit} />))
    const input = host.querySelector("input")!
    for (const value of ["", "1", "12", "120"]) type(input, value)
    expect(input.value).toBe("120")
    expect(onCommit).not.toHaveBeenCalled()
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(120)
  })

  it("clamps on blur, and puts the stored width back for an empty field", () => {
    const onCommit = vi.fn()
    act(() => root.render(<WidthField id="w" width={48} onCommit={onCommit} />))
    const input = host.querySelector("input")!
    type(input, "9000")
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
    expect(onCommit).toHaveBeenCalledWith(600)
    expect(input.value).toBe("600")
    type(input, "")
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
    expect(input.value).toBe("48")
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it("follows a collaborator's change", () => {
    act(() => root.render(<WidthField id="w" width={48} onCommit={() => {}} />))
    act(() => root.render(<WidthField id="w" width={200} onCommit={() => {}} />))
    expect(host.querySelector("input")!.value).toBe("200")
  })
})
