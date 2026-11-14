// @vitest-environment node
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { installedThemeTokenManifest } from "./installedThemeTokens"
import { tokenManifestText } from "./globalStyles"

// The API validates global styles against themes/tokens.manifest.json (#485). It is
// generated from the themes' configs and committed, since the API image is built without
// Node: a theme whose tokens changed without `npm run themes:manifest` fails here.
describe("themes/tokens.manifest.json", () => {
  it("is up to date with the themes' configs", () => {
    const committed = readFileSync(path.resolve(__dirname, "../../themes/tokens.manifest.json"), "utf8")
    expect(committed).toBe(tokenManifestText(installedThemeTokenManifest()))
  })

  it("has the default theme, which supports global styles", () => {
    const { themes } = installedThemeTokenManifest()
    expect(themes.default?.supports_global_styles).toBe(true)
  })
})
