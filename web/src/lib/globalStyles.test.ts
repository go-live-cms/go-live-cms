// @vitest-environment node
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  CONTRAST_PAIRS,
  SYSTEM_FONT_STACKS,
  changedGlobalStyleGroups,
  contrastFailureId,
  contrastFailures,
  declaredTokens,
  normalizeLength,
  themeTokenManifest,
  validateGlobalStyles,
  type FontOption,
  type GlobalStylesTheme,
} from "./globalStyles"
import defaultConfig from "../../themes/default/theme.config"

// The shared cases (#485): api/global_styles_test.go reads the same file, so the form and
// the API refuse the same overrides with the same code, path and message. Read with
// JSON.parse, not a JSON import: an object literal would turn "__proto__" into a prototype.
interface Vectors {
  theme: { tokens: Record<string, unknown>; font_options: FontOption[] }
  system_fonts: string[]
  contrast_pairs: [string, string, number][]
  valid: { name: string; input: unknown; normalized: unknown }[]
  invalid: { name: string; input: unknown; code: string; path: string; message: string }[]
  contrast: { name: string; styles: unknown; failing: string[] }[]
  groups: { name: string; before: unknown; after: unknown; groups: string[] }[]
}
const vectors: Vectors = JSON.parse(readFileSync(path.resolve(__dirname, "globalStyleVectors.json"), "utf8"))
const theme: GlobalStylesTheme = { tokens: vectors.theme.tokens, fontOptions: vectors.theme.font_options }

describe("globalStyleVectors.json", () => {
  it("names core's system fonts and contrast pairs", () => {
    expect(Object.keys(SYSTEM_FONT_STACKS)).toEqual(vectors.system_fonts)
    expect(CONTRAST_PAIRS.map((pair) => [...pair])).toEqual(vectors.contrast_pairs)
  })

  it.each(vectors.valid.map((v) => [v.name, v] as const))("accepts %s", (_, v) => {
    const result = validateGlobalStyles(v.input, theme)
    expect(result).toEqual({ ok: true, styles: v.normalized })
  })

  it.each(vectors.invalid.map((v) => [v.name, v] as const))("refuses %s", (_, v) => {
    const result = validateGlobalStyles(v.input, theme)
    expect(result).toEqual({ ok: false, code: v.code, path: v.path, message: v.message })
  })

  it.each(vectors.contrast.map((v) => [v.name, v] as const))("contrast: %s", (_, v) => {
    expect(contrastFailures(theme, v.styles).map(contrastFailureId)).toEqual(v.failing)
  })

  it.each(vectors.groups.map((v) => [v.name, v] as const))("groups: %s", (_, v) => {
    expect(changedGlobalStyleGroups(v.before, v.after)).toEqual(v.groups)
  })

  it("covers every injection vector the issue names, in colours and lengths", () => {
    for (const vector of [";", "}", "</style>", "url(", "var(", "expression("]) {
      const colour = vectors.invalid.find((v) => v.path === "colors.light.primary" && JSON.stringify(v.input).includes(JSON.stringify(vector).slice(1, -1)))
      const length = vectors.invalid.find((v) => v.code === "invalid_value" && /radius|fontSize/.test(v.path) && JSON.stringify(v.input).includes(JSON.stringify(vector).slice(1, -1)))
      expect(colour, `colour ${vector}`).toBeDefined()
      expect(length, `length ${vector}`).toBeDefined()
    }
  })
})

describe("contrast failures", () => {
  it("names the pair, its ratio and the minimum", () => {
    const [failure] = contrastFailures(theme, { colors: { light: { text: "#cccccc" } } })
    expect(failure).toEqual({ palette: "light", foreground: "text", background: "background", ratio: expect.any(Number), minimum: 4.5 })
    expect(failure.ratio).toBeLessThan(4.5)
    expect(Math.round(failure.ratio * 100) / 100).toBe(failure.ratio)
  })

  it("never throws on a malformed override (it is a warning)", () => {
    expect(contrastFailures(theme, { colors: { light: { text: "not a colour" } } })).toEqual([])
    expect(contrastFailures(theme, null)).toEqual([])
    expect(contrastFailures(theme, "x")).toEqual([])
  })
})

describe("the default theme", () => {
  const defaultTheme = { tokens: declaredTokens(defaultConfig), fontOptions: defaultConfig.fontOptions }

  it("accepts a palette change and its own font options", () => {
    const result = validateGlobalStyles(
      { colors: { light: { primary: "#155e4b" }, dark: { primary: "#3fe0b3" } }, typography: { fontFamily: { heading: "literata", base: "inter" } } },
      defaultTheme,
    )
    expect(result.ok).toBe(true)
  })

  it("accepts its own values back (nothing it declares is outside the grammar)", () => {
    const { colors, blockColors, typography, layout, spacing, radius } = declaredTokens(defaultConfig) as Record<string, Record<string, unknown>>
    const { fontFamily: _ignored, ...scale } = typography
    expect(validateGlobalStyles({ colors, blockColors, typography: scale, layout, spacing, radius }, defaultTheme).ok).toBe(true)
  })

  it("offers each of its fonts by id", () => {
    expect(defaultConfig.fontOptions?.map((option) => option.id)).toEqual(["literata", "inter", "jetbrains-mono"])
    for (const option of defaultConfig.fontOptions ?? []) expect(option.id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/)
  })
})

describe("normalizeLength", () => {
  it("is the default theme's scale form", () => {
    expect(normalizeLength("clamp(1.0625rem, 1rem + 0.25vw, 1.1875rem)")).toBe("clamp(1.0625rem, 1rem + 0.25vw, 1.1875rem)")
    expect(normalizeLength("x".repeat(101))).toBeNull()
  })
})

describe("themeTokenManifest", () => {
  it("lists the themes that declare colours, with their tokens and font options", () => {
    const manifest = themeTokenManifest({ default: defaultConfig, bare: { name: "Bare" } })
    expect(Object.keys(manifest.themes)).toEqual(["default"])
    expect(manifest.themes.default.supports_global_styles).toBe(true)
    expect(manifest.themes.default.font_options.map((option) => option.id)).toEqual(["literata", "inter", "jetbrains-mono"])
    expect(Object.keys(manifest.themes.default.tokens)).toEqual(["colors", "blockColors", "typography", "layout", "spacing", "radius"])
  })

  it("refuses a font option the API's loader would refuse at startup", () => {
    const withFont = (fontOptions: unknown) => ({ default: { ...defaultConfig, fontOptions } as object })
    expect(() => themeTokenManifest(withFont([{ id: "Source Serif", label: "x", stack: "serif" }]))).toThrow(/fontOptions/)
    expect(() => themeTokenManifest(withFont([{ id: "ok", label: "x", stack: "" }]))).toThrow(/fontOptions/)
    expect(() => themeTokenManifest(withFont([{ id: "ok", label: "x", stack: "serif" }]))).not.toThrow()
  })
})
