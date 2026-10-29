import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { PRESENCE_COLORS } from "@gl-admin/lib/collaboration/postCollab"

// The design tokens (#337) must keep the WCAG AA contrast the Foundations board
// promises, in both themes. Reads _tokens.scss as text: each theme is a mixin of
// `--name: #hex;` declarations.

const source = readFileSync(path.resolve("gl-admin/assets/styles/_tokens.scss"), "utf8")

function mixin(name: string): Record<string, string> {
  const start = source.indexOf(`@mixin ${name} {`)
  if (start < 0) throw new Error(`no @mixin ${name}`)
  const body = source.slice(start, source.indexOf("\n}", start))
  const tokens: Record<string, string> = {}
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)) tokens[m[1]] = m[2].toLowerCase()
  return tokens
}

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

// [foreground, background, minimum]
const PAIRS: [string, string, number][] = [
  ["text-primary", "background", TEXT],
  ["text-primary", "background-subtle", TEXT],
  ["text-primary", "background-hover", TEXT],
  ["text-primary", "surface-raised", TEXT],
  ["text-secondary", "background", TEXT],
  ["text-secondary", "background-subtle", TEXT],
  ["text-secondary", "background-hover", TEXT],
  ["text-selected", "background", TEXT],
  ["text-selected", "accent-subtle", TEXT],
  ["accent-on", "accent-solid", TEXT],
  ["accent-on", "danger-solid", TEXT],
  ["success-text", "background", TEXT],
  ["warning-text", "background", TEXT],
  ["danger-text", "background", TEXT],
  ["danger-text", "danger-bg", TEXT],
  ["success-label", "success-bg", TEXT],
  ["warning-label", "warning-bg", TEXT],
  ["info-text", "info-bg", TEXT],
  ["tooltip-color", "tooltip-background", TEXT],
  ["code-inline-color", "code-inline-background", TEXT],
  ["text-primary", "code-block-background", TEXT],
  ["control-border", "background", UI],
  ["focus-ring", "background", UI],
]

describe.each(["light", "dark"])("%s theme tokens", (theme) => {
  const tokens = mixin(theme)

  it("defines the same color tokens as the other theme", () => {
    const other = mixin(theme === "light" ? "dark" : "light")
    expect(Object.keys(tokens).sort()).toEqual(Object.keys(other).sort())
  })

  it.each(PAIRS)("%s on %s meets %d:1", (fg, bg, min) => {
    expect(tokens[fg], fg).toBeDefined()
    expect(tokens[bg], bg).toBeDefined()
    expect(contrast(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(min)
  })
})

describe("variables.scss", () => {
  // Its :root and dark-tokens blocks are emitted alongside the tokens, so a name it
  // re-declares would override the value tested above.
  it("doesn't re-declare a design token", () => {
    const legacy = readFileSync(path.resolve("gl-admin/assets/styles/variables.scss"), "utf8")
    const declaredIn = (scss: string) => new Set([...scss.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((m) => m[1]))
    const declared = declaredIn(legacy)
    const tokens = [...declaredIn(source)]
    expect(tokens.length).toBeGreaterThan(100)
    expect(tokens.filter((name) => declared.has(name))).toEqual([])
  })
})

describe("presence colours", () => {
  const presence = Object.entries(mixin("static"))
    .filter(([name]) => name.startsWith("presence-"))
    .map(([, hex]) => hex)

  it("are the eight colours postCollab sends over awareness", () => {
    expect(presence).toHaveLength(8)
    expect(PRESENCE_COLORS.map((c) => c.toLowerCase())).toEqual(presence)
  })

  it.each(presence)("%s carries a white name label at AA", (hex) => {
    expect(contrast("#ffffff", hex)).toBeGreaterThanOrEqual(TEXT)
  })
})
