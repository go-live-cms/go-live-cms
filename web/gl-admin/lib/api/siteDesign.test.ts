import { beforeEach, describe, expect, it, vi } from "vitest"

// The site design client (#487): the 409s it turns into errors the screen handles, and a
// revoked token refreshed once (apiCall's rule) instead of failing every save.

const fetchMock = vi.hoisted(() => vi.fn())
const auth = vi.hoisted(() => ({ forceRefresh: vi.fn() }))
vi.mock("../api", () => ({ authenticatedFetch: fetchMock }))
vi.mock("../auth", () => ({ authManager: auth }))

import { ContrastUnconfirmedError, StylesChangedError, publishSiteDesign, saveGlobalStyles } from "./siteDesign"

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

beforeEach(() => {
  fetchMock.mockReset()
  auth.forceRefresh.mockReset()
})

describe("saveGlobalStyles", () => {
  it("sends the whole draft with its base revision", async () => {
    fetchMock.mockResolvedValue(json(200, { draft_revision: 4 }))
    await saveGlobalStyles({ layout: { gutter: "24px" } }, 3)
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/site-design/global-styles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ styles: { layout: { gutter: "24px" } }, base_revision: 3 }),
    })
  })

  it("throws the other admin's draft on styles_changed", async () => {
    fetchMock.mockResolvedValue(json(409, { code: "styles_changed", current: { draft_revision: 9 } }))
    const error = await saveGlobalStyles({}, 3).catch((e) => e)
    expect(error).toBeInstanceOf(StylesChangedError)
    expect(error.current.draft_revision).toBe(9)
  })

  it("refreshes a revoked token and tries once more", async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: "token expired" }))
      .mockResolvedValueOnce(json(200, { draft_revision: 4 }))
    auth.forceRefresh.mockResolvedValue(true)
    await expect(saveGlobalStyles({}, 3)).resolves.toEqual({ draft_revision: 4 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("keeps the 401 when the refresh fails", async () => {
    fetchMock.mockResolvedValue(json(401, { error: "token expired" }))
    auth.forceRefresh.mockResolvedValue(false)
    await expect(saveGlobalStyles({}, 3)).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("publishSiteDesign", () => {
  it("names the failing pairs when contrast isn't confirmed", async () => {
    const pair = { palette: "dark", foreground: "primary", background: "surface", ratio: 4.1, minimum: 4.5 }
    fetchMock.mockResolvedValue(json(409, { code: "contrast_unconfirmed", pairs: [pair] }))
    const error = await publishSiteDesign().catch((e) => e)
    expect(error).toBeInstanceOf(ContrastUnconfirmedError)
    expect(error.pairs).toEqual([pair])
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ confirm_contrast: false })
  })

  it("sends confirm_contrast for Publish anyway", async () => {
    fetchMock.mockResolvedValue(json(200, { release: { id: 1 } }))
    await publishSiteDesign({ confirmContrast: true })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ confirm_contrast: true })
  })
})
