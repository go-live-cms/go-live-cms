import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../api", () => ({
  apiCall: vi.fn(async () => ({ token: "v4.public.abc.def", theme: "default", expires_at: "2026-11-15T10:15:00Z" })),
}))

import { apiCall } from "../api"
import { openDesignPreview } from "./designPreview"

afterEach(() => vi.restoreAllMocks())

describe("openDesignPreview", () => {
  it("posts a fresh token to /gl-preview in the named frame, never in a URL", async () => {
    let submitted: HTMLFormElement | null = null
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
      submitted = this
    })
    const preview = await openDesignPreview("site-preview", "/category/guides")

    expect(apiCall).toHaveBeenCalledWith("/site-design/preview", { method: "POST" })
    expect(preview.token).toBe("v4.public.abc.def")
    const form = submitted as unknown as HTMLFormElement
    expect(form.method).toBe("post")
    expect(new URL(form.action).pathname).toBe("/gl-preview")
    expect(new URL(form.action).search).toBe("")
    expect(form.target).toBe("site-preview")
    expect((form.elements.namedItem("token") as HTMLInputElement).value).toBe("v4.public.abc.def")
    expect((form.elements.namedItem("redirect") as HTMLInputElement).value).toBe("/category/guides")
    // The form doesn't stay in the page.
    expect(document.querySelector("form")).toBeNull()
  })
})
