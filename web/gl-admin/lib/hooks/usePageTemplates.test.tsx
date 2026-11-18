import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// usePageTemplates (#336, #494): one request for what mounts together, asked again on every
// mount (a template published or reset in the Site editor shows up without a reload), the
// last answer kept when a later read fails, and nothing cached from before a reset.

const api = vi.hoisted(() => ({ getPageTemplates: vi.fn() }))
vi.mock("@gl-admin/lib/api/posts", () => api)

import { resetPageTemplates, usePageTemplates } from "./usePageTemplates"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const answer = (theme: string, builder: string[] = []) => ({
  theme: { slug: theme.toLowerCase(), name: theme },
  templates: [{ name: "default", label: "Default" }],
  builder_templates: builder.map((label) => ({ name: `block:${label.toLowerCase()}`, label })),
})

function Probe({ id }: { id: string }) {
  const { choices, failed } = usePageTemplates()
  return (
    <p data-probe={id}>
      {failed ? "failed" : choices ? `${choices.themeName}: ${choices.builder.map((t) => t.label).join(",") || "none"}` : "loading"}
    </p>
  )
}

let container: HTMLDivElement
let root: Root
const settle = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  })
const text = (id: string) => container.querySelector(`[data-probe='${id}']`)?.textContent
const mount = async (...ids: string[]) => {
  await act(async () => root.render(<>{ids.map((id) => <Probe key={id} id={id} />)}</>))
  await settle()
}
const unmount = async () => {
  await act(async () => root.render(<></>))
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.getPageTemplates.mockReset()
  resetPageTemplates()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("usePageTemplates", () => {
  it("shares one request between what mounts together", async () => {
    api.getPageTemplates.mockResolvedValue(answer("Paper", ["Landing"]))
    await mount("row", "field")
    expect(api.getPageTemplates).toHaveBeenCalledTimes(1)
    expect(text("row")).toBe("Paper: Landing")
    expect(text("field")).toBe("Paper: Landing")
  })

  it("asks again on the next mount, showing the last answer meanwhile", async () => {
    api.getPageTemplates.mockResolvedValueOnce(answer("Paper"))
    await mount("field")
    expect(text("field")).toBe("Paper: none")
    await unmount()

    // Published in the Site editor since.
    let release!: (value: unknown) => void
    api.getPageTemplates.mockReturnValueOnce(new Promise((r) => (release = r)))
    await mount("field")
    expect(text("field")).toBe("Paper: none")
    await act(async () => release(answer("Paper", ["Landing"])))
    await settle()
    expect(text("field")).toBe("Paper: Landing")
    expect(api.getPageTemplates).toHaveBeenCalledTimes(2)
  })

  it("keeps the last answer when a later read fails, and fails only with nothing to show", async () => {
    api.getPageTemplates.mockRejectedValueOnce(new Error("down"))
    await mount("field")
    expect(text("field")).toBe("failed")
    await unmount()

    api.getPageTemplates.mockResolvedValueOnce(answer("Paper", ["Landing"]))
    await mount("field")
    expect(text("field")).toBe("Paper: Landing")
    await unmount()

    api.getPageTemplates.mockRejectedValueOnce(new Error("down"))
    await mount("field")
    expect(text("field")).toBe("Paper: Landing")
  })

  it("never caches an answer that started before a reset (another theme's list)", async () => {
    let release!: (value: unknown) => void
    api.getPageTemplates.mockReturnValueOnce(new Promise((r) => (release = r)))
    await mount("field")
    // The admin activates another theme meanwhile.
    resetPageTemplates()
    api.getPageTemplates.mockResolvedValueOnce(answer("Ink", ["Docs"]))
    await act(async () => release(answer("Paper", ["Landing"])))
    await settle()
    expect(text("field")).toBe("Ink: Docs")
    await unmount()

    // What's cached is the new theme's.
    api.getPageTemplates.mockReturnValueOnce(new Promise(() => {}))
    await mount("field")
    expect(text("field")).toBe("Ink: Docs")
  })
})
