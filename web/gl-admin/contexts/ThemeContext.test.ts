import { describe, expect, it } from "vitest"
import { loadThemeConfig } from "./ThemeContext"

describe("loadThemeConfig", () => {
  it("loads a bundled theme's config without fetching its source", async () => {
    // The real build-time map: the production image can't serve theme.config.ts.
    const config = await loadThemeConfig("default")
    expect(config?.menuLocations).toBeDefined()
  })

  it("accepts a config exported as default", async () => {
    const config = { name: "Other" }
    const loaders = { "../../themes/other/theme.config.ts": async () => ({ default: config }) }
    expect(await loadThemeConfig("other", loaders)).toBe(config)
  })

  it("is null for a theme that isn't in this build", async () => {
    expect(await loadThemeConfig("missing", {})).toBeNull()
  })
})
