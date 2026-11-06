import { readdirSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { BLOCK_COLORS } from "@gl-admin/lib/blocks-spec"
import defaultConfig from "./default/theme.config"
import { themeCssVariables } from "./default/tokens"

// Block colours (#356): every theme styles every palette value, `.gl-color-<value>`, from
// `--block-*` custom properties it defines for light and for dark. A theme added later
// must do the same, or a tinted block renders in that theme's default colours.

const root = path.resolve("themes")
const themes = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, "theme.config.ts")))
  .map((entry) => entry.name)

function sheetOf(theme: string): string {
  const css = readFileSync(path.join(root, theme, "styles", "theme.css"), "utf8")
  // The default theme's tokens come from theme.config.ts (base.astro, tokens.ts).
  return theme === "default" ? `${themeCssVariables(defaultConfig)}\n${css}` : css
}

/** The custom properties each innermost rule defines, split by whether its selector is dark. */
function definitions(css: string): { light: Set<string>; dark: Set<string> } {
  const light = new Set<string>()
  const dark = new Set<string>()
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "")
  for (const [, selector, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const target = /dark/.test(selector) ? dark : light
    for (const [, name] of body.matchAll(/--(block-[a-z-]+)\s*:/g)) target.add(name)
  }
  return { light, dark }
}

describe("block colours in every theme (#356)", () => {
  it("finds the themes", () => {
    expect(themes).toEqual(expect.arrayContaining(["default", "example", "test"]))
  })

  describe.each(themes)("%s", (theme) => {
    const css = sheetOf(theme)

    it.each(BLOCK_COLORS)("styles .gl-color-%s from its --block-* property", (color) => {
      const rule = new RegExp(`\\.gl-color-${color}\\s*\\{([^}]*)\\}`).exec(css)
      expect(rule, `.gl-color-${color}`).not.toBeNull()
      const property = color.endsWith("-background") ? "background" : "color"
      expect(rule![1]).toMatch(new RegExp(`${property}:\\s*var\\(--block-${color}\\)`))
    })

    it("defines every --block-* property for light and for dark", () => {
      const { light, dark } = definitions(css)
      const expected = BLOCK_COLORS.map((color) => `block-${color}`).sort()
      expect([...light].sort()).toEqual(expected)
      expect([...dark].sort()).toEqual(expected)
    })
  })
})
