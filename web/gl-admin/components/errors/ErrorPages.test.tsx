import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, apiErrorFromResponse } from "@gl-admin/lib/api/errors"
import { errorPageFor, isChunkLoadError } from "@gl-admin/lib/errorPages"
import { isSiteAdmin } from "@gl-admin/lib/roles"

// Error pages (#339): which page an error maps to, the 403 wording and the copyable
// error ID taken from the API's request_id.

const auth = vi.hoisted(() => ({ user: { id: 7, full_name: "Elena V.", role: "contributor" } }))
vi.mock("@gl-admin/lib/auth", () => ({
  authManager: { getState: () => ({ user: auth.user }), subscribe: () => () => {}, logout: vi.fn() },
}))

import { ErrorPage } from "./ErrorPages"
import ErrorBoundary from "@gl-admin/components/ErrorBoundary"
import RequireRole from "@gl-admin/components/RequireRole"
import NotFound from "@gl-admin/pages/NotFound"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (status: number, body: object, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

describe("errorPageFor", () => {
  it("maps an API 403 to the forbidden page, keeping only a specific reason", async () => {
    expect(errorPageFor(await apiErrorFromResponse(json(403, { error: "forbidden", request_id: "r1" })))).toEqual({
      kind: "forbidden",
      serverMessage: null,
    })
    expect(errorPageFor(await apiErrorFromResponse(json(403, { error: "you can only edit your own posts" })))).toEqual({
      kind: "forbidden",
      serverMessage: "You can only edit your own posts.",
    })
  })

  it("maps a 5xx to the generic page with the request_id as the error ID", async () => {
    const err = await apiErrorFromResponse(json(503, { error: "database unavailable", request_id: "7f3a-91c2-4e0b" }))
    expect(err.requestId).toBe("7f3a-91c2-4e0b")
    expect(errorPageFor(err)).toEqual({ kind: "error", status: 503, requestId: "7f3a-91c2-4e0b" })
  })

  it("falls back to the X-Request-ID header when the body isn't the API's JSON", async () => {
    const err = await apiErrorFromResponse(
      new Response("<html>Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html", "X-Request-ID": "hdr-1" } })
    )
    expect(errorPageFor(err)).toEqual({ kind: "error", status: 502, requestId: "hdr-1" })
  })

  it("maps an API 404 to the not-found page, and a crash to the generic page without an ID", () => {
    expect(errorPageFor(new ApiError("gone", 404))).toEqual({ kind: "not-found" })
    expect(errorPageFor(new TypeError("x is undefined"))).toEqual({ kind: "error", status: null, requestId: null })
  })

  it("recognises a failed lazy-page download", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: /x.js"))).toBe(true)
    expect(isChunkLoadError(new Error("nope"))).toBe(false)
  })
})

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

function render(ui: ReactElement, path = "/") {
  act(() =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<p>Home</p>} />
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    )
  )
}

const text = () => container.textContent ?? ""
const heading = () => container.querySelector("h1")?.textContent

describe("error pages", () => {
  it("renders the 404 for an unknown route, naming the broken URL", () => {
    render(<NotFound />, "/no/such/page")
    expect(text()).toContain("Error 404")
    expect(heading()).toBe("We can’t find that page")
    expect(container.querySelector("code")!.textContent).toBe("/gl-admin/no/such/page")
    expect(container.querySelector<HTMLAnchorElement>("a")!.getAttribute("href")).toBe("/")
  })

  it("renders the 403 from the router guard with the area and the signed-in user", () => {
    render(
      <RequireRole allow={isSiteAdmin} area="Settings">
        <p>Secret settings</p>
      </RequireRole>,
      "/settings"
    )
    expect(text()).not.toContain("Secret settings")
    expect(heading()).toBe("You don’t have access to this")
    expect(text()).toContain("Settings are open to admins only. You’re signed in as Elena V., a contributor.")
  })

  it("lets an allowed role through the guard", () => {
    auth.user.role = "admin"
    render(
      <RequireRole allow={isSiteAdmin} area="Settings">
        <p>Secret settings</p>
      </RequireRole>,
      "/settings"
    )
    auth.user.role = "contributor"
    expect(text()).toContain("Secret settings")
  })

  it("renders the generic page with a copyable error ID for an API 5xx", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    const onRetry = vi.fn()

    render(<ErrorPage error={new ApiError("x", 500, null, null, "boom", "req-42")} onRetry={onRetry} />, "/content/edit/9")
    expect(text()).toContain("Error 500")
    expect(heading()).toBe("Something went wrong")
    expect(container.querySelector(".gl-error-page__id-value")!.textContent).toBe("req-42")

    const buttons = Array.from(container.querySelectorAll("button"))
    await act(async () => buttons.find((b) => b.textContent === "Copy")!.click())
    expect(writeText).toHaveBeenCalledWith("req-42")
    expect(text()).toContain("Copied")

    act(() => buttons.find((b) => b.textContent === "Try again")!.click())
    expect(onRetry).toHaveBeenCalled()
  })

  it("hides the error ID box when there's no request_id", () => {
    render(<ErrorPage error={new Error("render crash")} />, "/x")
    expect(heading()).toBe("Something went wrong")
    expect(container.querySelector(".gl-error-page__id")).toBeNull()
  })

  it("shows the matching page for an ApiError a page throws into the boundary", () => {
    const Throws = () => {
      throw new ApiError("no", 403, null, null, "forbidden", "r9")
    }
    vi.spyOn(console, "error").mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Throws />
      </ErrorBoundary>,
      "/themes"
    )
    expect(heading()).toBe("You don’t have access to this")
    expect(text()).toContain("Your account doesn't have permission to open this.")
  })
})
