import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../api", () => ({ apiCall: vi.fn(async () => ({ versions: [] })) }))

import { apiCall } from "../api"
import {
  deleteSiteTemplate,
  discardGlobalStyles,
  getSiteTemplateDefault,
  listSiteDesignReleases,
  publishSiteDesign,
  recordSiteTemplateRestore,
  recordSiteTemplateStartOver,
  resetSiteTemplate,
  restoreGlobalStyleVersion,
} from "./siteDesign"

afterEach(() => vi.clearAllMocks())

describe("site design client (#492)", () => {
  it("publishes with #485's body, so a styles-only caller is unchanged", async () => {
    await publishSiteDesign()
    expect(apiCall).toHaveBeenLastCalledWith("/site-design/publish", { method: "POST", body: { confirm_contrast: false } })
    await publishSiteDesign({ confirmContrast: true })
    expect(apiCall).toHaveBeenLastCalledWith("/site-design/publish", { method: "POST", body: { confirm_contrast: true } })
  })

  it("names the routes", async () => {
    await resetSiteTemplate(7)
    expect(apiCall).toHaveBeenLastCalledWith("/site-design/templates/7/reset", { method: "POST" })
    await deleteSiteTemplate(7)
    expect(apiCall).toHaveBeenLastCalledWith("/site-design/templates/7", { method: "DELETE" })
    await recordSiteTemplateRestore(7, 3)
    expect(apiCall).toHaveBeenLastCalledWith("/site-design/templates/7/versions/3/restore", { method: "POST" })
    await getSiteTemplateDefault(7, "starter")
    expect(apiCall).toHaveBeenLastCalledWith("/site-design/templates/7/default?from=starter")
    await recordSiteTemplateStartOver(7)
    expect(apiCall).toHaveBeenLastCalledWith("/site-design/templates/7/start-over", { method: "POST", body: {} })
    await listSiteDesignReleases({ limit: 5, before: 40 })
    expect(apiCall).toHaveBeenLastCalledWith("/site-design/releases?limit=5&before=40")
    await listSiteDesignReleases()
    expect(apiCall).toHaveBeenLastCalledWith("/site-design/releases")
    await restoreGlobalStyleVersion(2, 9)
    expect(apiCall).toHaveBeenLastCalledWith("/site-design/global-styles/versions/2/restore", { method: "POST", body: { base_revision: 9 } })
    await discardGlobalStyles(9)
    expect(apiCall).toHaveBeenLastCalledWith("/site-design/global-styles/discard", { method: "POST", body: { base_revision: 9 } })
  })
})
