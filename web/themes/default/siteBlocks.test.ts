import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

// The site blocks in the default theme (#488, the blocks canvas's "Published site blocks" at
// 1280 and 375). jsdom has no layout, so this pins the rules that decide both widths. The
// markup is the header's own (.site-title, .site-nav, .search-form), styled the same way.

const css = readFileSync(resolve(__dirname, "styles/theme.css"), "utf8")
const section = css.slice(css.indexOf("/* ---------- site blocks (#488)"))

function rule(selector: string, scope = section): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`(?:^|\\n|})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(scope)
  return match?.[1] ?? ""
}

describe("the site blocks' rules", () => {
  it("are their own section, after the header's, which they don't change", () => {
    expect(section.length).toBeGreaterThan(0)
    expect(css.indexOf("/* ---------- site blocks (#488)")).toBeGreaterThan(css.indexOf(".site-nav {"))
  })

  it("the title, tagline and logo", () => {
    expect(rule(".site .site-title-block a")).toContain("color: inherit")
    expect(rule(".site-tagline")).toContain("color: var(--color-text-muted)")
    expect(rule(".site-logo-block")).toContain("min-height: 44px")
    expect(rule(".site-logo")).toContain("max-width: 100%")
    expect(rule(".site-logo")).toContain("height: auto")
  })

  it("at 1280: a navigation block's links in a row (or a column), the phone button hidden", () => {
    expect(rule(".nav-block .site-nav")).toContain("margin-left: 0")
    expect(rule(".site-nav.is-column")).toContain("flex-direction: column")
    expect(rule(".nav-overlay")).toContain("display: none")
  })

  it("at 375: one that folds shows its menu button, one that never folds keeps its links", () => {
    const phone = section.slice(section.indexOf("@media (max-width: 760px)"))
    expect(phone.length).toBeGreaterThan(0)
    // The header hides .site-nav at this width (:root[data-js] .site-nav): these win by specificity.
    expect(rule(":root .nav-block > .site-nav", phone)).toContain("display: flex")
    expect(rule(":root .nav-block.has-overlay > .site-nav", phone)).toContain("display: none")
    expect(rule(".nav-block.has-overlay > .nav-overlay", phone)).toContain("display: block")
  })

  it("the overlay panel fits a phone and has tap-sized links", () => {
    expect(rule(".nav-overlay-panel")).toContain("min-width: min(280px, calc(100vw - 2 * var(--container-gutter)))")
    expect(rule(".site .nav-overlay-panel a")).toContain("min-height: 48px")
  })

  it("only reads the theme's tokens", () => {
    expect(section.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })
})