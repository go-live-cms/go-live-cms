import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The editor's notice for an imported post (#150): what the import left out, "Copy the
// original as text", and Dismiss (kept by the API).

const api = vi.hoisted(() => ({ getImportNotice: vi.fn(), dismissImportNotice: vi.fn() }))
vi.mock("@gl-admin/lib/api/imports", () => api)

import ImportNotice from "./ImportNotice"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const settle = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  })

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.getImportNotice.mockReset()
  api.dismissImportNotice.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const button = (label: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label)

describe("ImportNotice", () => {
  it("says what was left out, copies the original and dismisses", async () => {
    api.getImportNotice.mockResolvedValue({
      item_id: 9,
      dropped: [
        { label: "Shortcode [contact-form-7]", after: "Get in touch", original: "[contact-form-7 id=5]" },
        { label: "Latest posts block", original: "<!-- wp:latest-posts /-->" },
      ],
      media_failed: [],
    })
    api.dismissImportNotice.mockResolvedValue(undefined)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    await act(async () => root.render(<ImportNotice postId={4} />))
    await settle()
    expect(api.getImportNotice).toHaveBeenCalledWith(4)
    expect(container.textContent).toContain("2 blocks couldn’t be kept in the import")
    expect(container.textContent).toContain("Shortcode [contact-form-7] — after “Get in touch”")
    expect(container.textContent).toContain("Latest posts block — at the start")

    await act(async () => button("Copy the original as text")!.click())
    expect(writeText).toHaveBeenCalledWith("[contact-form-7 id=5]\n\n<!-- wp:latest-posts /-->")

    await act(async () => button("Dismiss")!.click())
    await settle()
    expect(api.dismissImportNotice).toHaveBeenCalledWith(4, 9)
    expect(container.textContent).toBe("")
  })

  it("renders nothing for a post without one", async () => {
    api.getImportNotice.mockResolvedValue(null)
    await act(async () => root.render(<ImportNotice postId={4} />))
    await settle()
    expect(container.innerHTML).toBe("")
  })
})
