import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { SPACER_STEPS } from "@gl-admin/lib/blocks-spec"
import themeConfig from "./theme.config"

// The layout blocks in the default theme (#426, "Published · layout · 1280" / "375 ·
// layout"). A rendered check isn't possible in jsdom (no layout), so this pins the rules
// that decide the two widths: side by side at 1280, one column in order at 375.

const css = readFileSync(resolve(__dirname, "styles/theme.css"), "utf8")

/** The body of the rule whose selector is exactly `selector` (optionally inside `media`). */
function rule(selector: string, media?: string): string {
  const scope = media ? css.slice(css.indexOf(`@media (${media})`)) : css
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`(?:^|\\n|})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(scope)
  return match?.[1] ?? ""
}

describe("at 1280: the rows", () => {
  it("two equal columns by default, three and four by their class", () => {
    expect(rule(".columns")).toContain("display: grid")
    expect(rule(".columns")).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))")
    expect(rule(".columns.is-3-columns")).toContain("repeat(3, minmax(0, 1fr))")
    expect(rule(".columns.is-4-columns")).toContain("repeat(4, minmax(0, 1fr))")
  })

  it("the splits", () => {
    expect(rule(".columns.is-33-67")).toContain("minmax(0, 1fr) minmax(0, 2fr)")
    expect(rule(".columns.is-67-33")).toContain("minmax(0, 2fr) minmax(0, 1fr)")
  })

  it("the row's spacing comes from the theme's scale", () => {
    expect(rule(".columns")).toContain("gap: var(--space-6) var(--space-7)")
  })

  it("a column resets the prose rhythm for its own blocks, like a group", () => {
    expect(rule(".prose .column > *")).toContain("margin: 0")
    expect(rule(".prose .column > * + *")).toContain("margin-top: 0.8em")
  })

  it("a row in a group fills the group, whatever its width class", () => {
    const body = rule(".prose .group .columns:is(.alignwide, .alignfull)")
    expect(body).toContain("width: auto")
    expect(body).toContain("transform: none")
    expect(body).toContain("padding-inline: 0")
  })

  it("a full-width row keeps the page's gutter", () => {
    const body = rule(".prose .columns.alignfull")
    expect(body).toContain("padding-inline: var(--container-gutter)")
    expect(body).toContain("box-sizing: border-box")
  })

  it("nothing lifts a row out of a full-width group's content column", () => {
    expect(rule(".prose .group > .columns")).toBe("")
  })
})

describe("at 375: one column, in order", () => {
  it("every row stacks at 640px and below", () => {
    const at = css.indexOf("@media (max-width: 640px)", css.indexOf("Columns (#426"))
    expect(at).toBeGreaterThan(-1)
    const block = css.slice(at, css.indexOf("}\n}", at))
    for (const selector of [".columns", ".columns.is-3-columns", ".columns.is-4-columns", ".columns.is-33-67", ".columns.is-67-33"]) {
      expect(block, selector).toContain(selector)
    }
    expect(block).toContain("grid-template-columns: minmax(0, 1fr)")
    // The DOM order decides the stack; no rule may reorder a column.
    expect(css).not.toMatch(/\.column[^{]*\{[^}]*\border:/)
  })

  it("buttons wrap, and fill the row on a small phone", () => {
    expect(rule(".buttons")).toContain("flex-wrap: wrap")
    const at = css.indexOf("@media (max-width: 480px)", css.indexOf("Buttons (#426"))
    expect(css.slice(at, css.indexOf("}\n}", at))).toContain("flex: 1 1 100%")
  })
})

describe("the theme's buttons and spacing", () => {
  it("styles the variants the block uses, from tokens", () => {
    expect(css).toMatch(/\.site \.btn-primary\s*\{[^}]*background: var\(--color-primary\)/)
    expect(css).toMatch(/\.site \.btn-secondary\s*\{[^}]*border-color: var\(--color-border-strong\)/)
    expect(rule(".buttons.is-center")).toContain("justify-content: center")
  })

  it("defines every spacer step, at the size the editor says", () => {
    for (const { size, px } of SPACER_STEPS) expect(themeConfig.spacing?.[size], `--space-${size}`).toBe(`${px}px`)
  })
})
