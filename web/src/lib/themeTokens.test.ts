import { describe, expect, it } from "vitest"
import defaultConfig from "../../themes/default/theme.config"
import { themeConfig as exampleConfig } from "../../themes/example/theme.config"
import { NO_GLOBAL_STYLES, resolveThemeTokens, supportsGlobalStyles, themeCssVariables, type GlobalStyles } from "./themeTokens"

// The token half of the theme contract (#484, design 3.5 and 6.4). The default theme's own
// values and contrast are checked in themes/default/tokens.test.ts.

const css = (styles?: GlobalStyles) => themeCssVariables(resolveThemeTokens(defaultConfig, styles))

describe("resolveThemeTokens", () => {
  it("without an override is the theme's config itself", () => {
    expect(resolveThemeTokens(defaultConfig, undefined)).toBe(defaultConfig)
    expect(resolveThemeTokens(defaultConfig, null)).toBe(defaultConfig)
    expect(resolveThemeTokens(defaultConfig, NO_GLOBAL_STYLES)).toBe(defaultConfig)
    expect(css({})).toBe(themeCssVariables(defaultConfig))
  })

  it("changes the tokens an override names, in all three selectors, and nothing else", () => {
    const before = themeCssVariables(defaultConfig).split("\n")
    const after = css({ colors: { light: { primary: "#155e4b" }, dark: { primary: "#3fe0b3" } } }).split("\n")
    expect(after[0]).toBe(before[0].replace("--color-primary:#1b7760;", "--color-primary:#155e4b;"))
    expect(after[1]).toBe(before[1].replace("--color-primary:#1fd8a4;", "--color-primary:#3fe0b3;"))
    expect(after[2]).toBe(before[2].replace("--color-primary:#1fd8a4;", "--color-primary:#3fe0b3;"))
  })

  it("merges block colours, the type scale, line heights, layout, spacing and radius", () => {
    const out = css({
      blockColors: { light: { red: { text: "#aa0000" } }, dark: { red: { background: "#220000" } } },
      typography: { fontSize: { base: "1.125rem" }, lineHeight: { relaxed: 1.8 } },
      layout: { contentWidth: "720px" },
      spacing: { "4": "18px" },
      radius: { md: "10px" },
    })
    expect(out).toContain("--block-red:#aa0000;--block-red-background:#feebec;")
    expect(out).toContain("--block-red:#ff9592;--block-red-background:#220000;")
    expect(out).toContain("--size-base:1.125rem;")
    expect(out).toContain("--leading-relaxed:1.8;")
    expect(out).toContain("--content-width:720px;")
    expect(out).toContain("--space-4:18px;")
    expect(out).toContain("--radius-md:10px;")
  })

  it("never adds a token the theme doesn't declare", () => {
    const out = css({
      colors: { light: { brandNew: "#123456" } },
      blockColors: { light: { teal: { text: "#008080", background: "#e0ffff" } } },
      typography: { fontSize: { "5xl": "4rem" } },
      layout: { sidebarWidth: "300px" },
      spacing: { "11": "160px" },
      radius: { xl: "20px" },
      unknownGroup: { x: "1" },
    } as GlobalStyles)
    expect(out).toBe(themeCssVariables(defaultConfig))
  })

  it("never emits a value that could leave its declaration or the <style> element", () => {
    for (const value of ["red;color:blue", "x}body{color:red", "</style><script>", "a\\3b", "1px/*", "", "  "]) {
      expect(css({ colors: { light: { primary: value } }, layout: { container: value } })).toBe(themeCssVariables(defaultConfig))
    }
    expect(css({ typography: { lineHeight: { tight: "1.2" as unknown as number } } })).toBe(themeCssVariables(defaultConfig))
    expect(css({ typography: { lineHeight: { tight: Number.NaN } } })).toBe(themeCssVariables(defaultConfig))
  })

  it("leaves font families alone until #485 resolves their option ids", () => {
    expect(css({ typography: { fontFamily: { heading: "literata" } } })).toBe(themeCssVariables(defaultConfig))
  })

  it("never changes the theme's config", () => {
    const copy = JSON.stringify(defaultConfig)
    resolveThemeTokens(defaultConfig, { colors: { light: { primary: "#000000" } }, spacing: { "1": "2px" } })
    expect(JSON.stringify(defaultConfig)).toBe(copy)
  })
})

describe("supportsGlobalStyles", () => {
  it("is the theme's supports.globalStyles", () => {
    expect(supportsGlobalStyles(defaultConfig)).toBe(true)
    expect(supportsGlobalStyles(exampleConfig)).toBe(false)
    expect(supportsGlobalStyles({})).toBe(false)
  })
})
