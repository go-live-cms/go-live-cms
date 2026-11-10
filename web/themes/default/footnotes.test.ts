import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const css = readFileSync(resolve(__dirname, "styles/theme.css"), "utf8")

// #422: the markup the renderer writes has its rules (the canvas's "Published · text").
describe("the default theme's footnotes", () => {
  it.each([".prose .fn-ref", ".footnotes", ".footnotes h2", ".prose .footnotes ol", ".prose .fn-back"])("styles %s", (selector) => {
    expect(css).toContain(`${selector} {`)
  })

  it("keeps a linked note clear of the sticky header", () => {
    expect(css).toMatch(/\.prose \.footnotes li\s*\{[^}]*scroll-margin-top/)
  })
})
