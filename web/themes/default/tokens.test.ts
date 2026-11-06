import { describe, expect, it } from "vitest"
import themeConfig, { type ThemeColors } from "./theme.config"
import { cssName, themeCssVariables } from "./tokens"
import { AVATAR_COLORS } from "./lib/avatar"
import { BLOCK_COLOR_TOKENS } from "@gl-admin/lib/blocks-spec"

// The default theme's colours (#345) must keep the WCAG AA contrast the Foundations
// board promises, in both themes. Same check as gl-admin/assets/styles/tokens.test.ts
// does for the admin.

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const TEXT = 4.5 // AA, normal text
const UI = 3 // AA, control edges and focus indicators

type Key = keyof ThemeColors

// [foreground, background, minimum]: every pairing theme.css uses for text.
const PAIRS: [Key, Key, number][] = [
  ["text", "background", TEXT],
  ["text", "surface", TEXT],
  ["text", "surface2", TEXT],
  ["text", "highlight", TEXT],
  ["textMuted", "background", TEXT],
  ["textMuted", "surface", TEXT],
  ["textMuted", "surface2", TEXT],
  ["secondary", "background", TEXT],
  ["secondary", "surface", TEXT],
  ["secondary", "surface2", TEXT], // inline code
  ["secondary", "primarySubtle", TEXT], // the chosen theme in the header menu
  ["primary", "background", TEXT], // links, eyebrows
  ["primary", "surface", TEXT],
  ["primaryHover", "background", TEXT],
  ["onPrimary", "primary", TEXT], // primary buttons, skip link
  ["onPrimary", "primaryHover", TEXT],
  ["borderStrong", "background", UI], // outline buttons
  ["focus", "background", UI],
  ["focus", "surface", UI],
  // Callouts (#419): the page's text on each fill, links in it, and the tone's icon (a
  // graphic, so 3:1) on its fill.
  ["text", "infoBg", TEXT],
  ["text", "successBg", TEXT],
  ["text", "warningBg", TEXT],
  ["text", "dangerBg", TEXT],
  ["primary", "infoBg", TEXT],
  ["primary", "successBg", TEXT],
  ["primary", "warningBg", TEXT],
  ["primary", "dangerBg", TEXT],
  ["info", "infoBg", UI],
  ["success", "successBg", UI],
  ["warning", "warningBg", UI],
  ["danger", "dangerBg", UI],
  // To-do checkboxes (#419): the box edge on the page, the tick on a checked box.
  ["borderStrong", "surface", UI],
  ["onPrimary", "primary", UI],
]

describe.each(["light", "dark"] as const)("%s colours", (theme) => {
  const colors = themeConfig.colors[theme]

  it("defines the same tokens as the other theme, all as #rrggbb", () => {
    const other = themeConfig.colors[theme === "light" ? "dark" : "light"]
    expect(Object.keys(colors).sort()).toEqual(Object.keys(other).sort())
    for (const value of Object.values(colors)) expect(value).toMatch(/^#[0-9a-f]{6}$/)
  })

  it.each(PAIRS)("%s on %s meets %d:1", (fg, bg, min) => {
    expect(colors[fg], fg).toBeDefined()
    expect(colors[bg], bg).toBeDefined()
    expect(contrast(colors[fg]!, colors[bg]!)).toBeGreaterThanOrEqual(min)
  })
})

// Block colours (#356): every palette token, in both palettes; tinted text on every page
// surface, the page's text on every tinted block.
describe.each(["light", "dark"] as const)("%s block colours", (theme) => {
  const palette = themeConfig.blockColors![theme]
  const colors = themeConfig.colors[theme]

  it("defines every token, as #rrggbb", () => {
    expect(Object.keys(palette).sort()).toEqual([...BLOCK_COLOR_TOKENS].sort())
    for (const { text, background } of Object.values(palette)) {
      expect(text).toMatch(/^#[0-9a-f]{6}$/)
      expect(background).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it.each(BLOCK_COLOR_TOKENS)("%s meets 4.5:1 as text and as a fill", (token) => {
    const { text, background } = palette[token]
    for (const surface of [colors.background, colors.surface, colors.surface2!]) expect(contrast(text, surface)).toBeGreaterThanOrEqual(TEXT)
    expect(contrast(colors.text, background)).toBeGreaterThanOrEqual(TEXT)
  })

  it("becomes --block-* custom properties", () => {
    const css = themeCssVariables(themeConfig)
    expect(css).toContain(`--block-red:${palette.red.text};`)
    expect(css).toContain(`--block-red-background:${palette.red.background};`)
  })
})

describe("avatar colours", () => {
  it.each(AVATAR_COLORS)("white initials on %s meet 4.5:1", (color) => {
    expect(contrast("#ffffff", color)).toBeGreaterThanOrEqual(TEXT)
  })
})

describe("themeCssVariables", () => {
  const css = themeCssVariables(themeConfig)

  it("names tokens the way theme.css reads them", () => {
    expect(cssName("textMuted")).toBe("text-muted")
    expect(cssName("primaryHover")).toBe("primary-hover")
    expect(cssName("surface2")).toBe("surface-2")
    expect(css).toContain("--color-surface-2:#f1f0ef;")
    expect(css).toContain("--size-2xl:clamp(1.625rem, 1.4rem + 0.9vw, 2rem);")
    expect(css).toContain("--leading-relaxed:1.7;")
    expect(css).toContain("--content-width:680px;")
    expect(css).toContain("--wide-width:960px;")
    expect(css).toContain("--header-height:64px;")
    expect(css).toContain("--space-10:128px;")
    expect(css).toContain("--radius-full:999px;")
  })

  it("is light by default and dark by choice or by system preference", () => {
    const [root, media, dark] = css.split("\n")
    expect(root).toMatch(/^:root\{color-scheme:light;--color-primary:#1b7760;/)
    expect(media).toMatch(/^@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\)\{color-scheme:dark;--color-primary:#1fd8a4;/)
    expect(dark).toMatch(/^:root\[data-theme="dark"\]\{color-scheme:dark;--color-primary:#1fd8a4;/)
  })

  it("covers every var(--...) theme.css uses", async () => {
    const { readFileSync } = await import("node:fs")
    const path = await import("node:path")
    const sheet = readFileSync(path.resolve("themes/default/styles/theme.css"), "utf8")
    const defined = new Set([...css.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]))
    for (const m of sheet.matchAll(/--([a-z0-9-]+):/g)) defined.add(m[1]) // theme.css's own (--duration)
    const used = new Set([...sheet.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]))
    expect([...used].filter((name) => !defined.has(name))).toEqual([])
  })
})
