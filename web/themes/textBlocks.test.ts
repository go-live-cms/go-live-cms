import { readdirSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// The callout, pull quote and to-do list (#419) render with their classes only, and the
// callout says its tone in a `.sr-only` span. Every theme styles them, or a theme shows
// "Warning: " in front of every callout and unstyled blocks.

const root = path.resolve("themes")
const themes = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, "theme.config.ts")))
  .map((entry) => entry.name)

describe.each(themes)("theme %s styles the #419 blocks", (theme) => {
  const css = readFileSync(path.join(root, theme, "styles", "theme.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

  it.each([".sr-only", ".callout", ".callout.is-success", ".callout.is-warning", ".callout.is-danger", ".pullquote", ".todo-list"])("%s", (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    expect(css).toMatch(new RegExp(`${escaped}(?![\\w-])[^{]*\\{`))
  })

  it("hides .sr-only visually", () => {
    const rule = /\.sr-only\s*\{([^}]*)\}/.exec(css)?.[1] ?? ""
    expect(rule).toMatch(/position:\s*absolute/)
    expect(rule).toMatch(/clip:/)
  })
})
