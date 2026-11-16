import { beforeEach, describe, expect, it, vi } from "vitest"

// The site design client (#487): the 409s it turns into errors the screen handles, and a
// revoked token refreshed once (apiCall's rule) instead of failing every save.

const fetchMock = vi.hoisted(() => vi.fn())
const apiCallMock = vi.hoisted(() => vi.fn(async () => ({ versions: [] })))
const auth = vi.hoisted(() => ({ forceRefresh: vi.fn() }))
vi.mock("../api", () => ({ authenticatedFetch: fetchMock, apiCall: apiCallMock }))
vi.mock("../auth", () => ({ authManager: auth }))

import {
  ContrastUnconfirmedError,
  DesignInvalidError,
  StylesChangedError,
  deleteSiteTemplate,
  discardGlobalStyles,
  getSiteTemplateDefault,
  listSiteDesignReleases,
  publishSiteDesign,
  recordSiteTemplateRestore,
  recordSiteTemplateStartOver,
  resetSiteTemplate,
  restoreGlobalStyleVersion,
  saveGlobalStyles,
} from "./siteDesign"

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

beforeEach(() => {
  fetchMock.mockReset()
  apiCallMock.mockClear()
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

describe("publishSiteDesign with templates (#492)", () => {
  it("names what failed when a template or part can't go live", async () => {
    const problem = { code: "part_unresolved", id: 3, kind: "template", slug: "single", part: "sidebar" }
    fetchMock.mockResolvedValue(json(409, { code: "design_invalid", error: "nothing was published: …", problems: [problem] }))
    const error = await publishSiteDesign().catch((e) => e)
    expect(error).toBeInstanceOf(DesignInvalidError)
    expect(error.problems).toEqual([problem])
    expect(error.message).toContain("nothing was published")
  })

  it("keeps any other refusal an ApiError with the server's words", async () => {
    fetchMock.mockResolvedValue(json(503, { code: "collab_unavailable", error: "the collaboration server could not save the latest edits" }))
    await expect(publishSiteDesign()).rejects.toMatchObject({ status: 503 })
  })
})

describe("templates, parts and history (#492)", () => {
  it("names the routes", async () => {
    await resetSiteTemplate(7)
    expect(apiCallMock).toHaveBeenLastCalledWith("/site-design/templates/7/reset", { method: "POST" })
    await deleteSiteTemplate(7)
    expect(apiCallMock).toHaveBeenLastCalledWith("/site-design/templates/7", { method: "DELETE" })
    await recordSiteTemplateRestore(7, 3)
    expect(apiCallMock).toHaveBeenLastCalledWith("/site-design/templates/7/versions/3/restore", { method: "POST" })
    await getSiteTemplateDefault(7, "starter")
    expect(apiCallMock).toHaveBeenLastCalledWith("/site-design/templates/7/default?from=starter")
    await recordSiteTemplateStartOver(7)
    expect(apiCallMock).toHaveBeenLastCalledWith("/site-design/templates/7/start-over", { method: "POST", body: {} })
    await listSiteDesignReleases({ limit: 5, before: 40 })
    expect(apiCallMock).toHaveBeenLastCalledWith("/site-design/releases?limit=5&before=40")
    await listSiteDesignReleases()
    expect(apiCallMock).toHaveBeenLastCalledWith("/site-design/releases")
    await restoreGlobalStyleVersion(2, 9)
    expect(apiCallMock).toHaveBeenLastCalledWith("/site-design/global-styles/versions/2/restore", { method: "POST", body: { base_revision: 9 } })
    await discardGlobalStyles(9)
    expect(apiCallMock).toHaveBeenLastCalledWith("/site-design/global-styles/discard", { method: "POST", body: { base_revision: 9 } })
  })
})
