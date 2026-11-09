import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// The default theme styles the embed placeholder and the loaded player (#425, "Published ·
// media & embeds" at 1280 and 375). The colours are its tokens (tokens.test.ts checks every
// var() is defined, in light and dark).

const css = readFileSync(path.resolve("themes/default/styles/theme.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? null
}

describe("the default theme's embeds (#425)", () => {
  it("draws the placeholder 16:9, from the tokens", () => {
    const frame = rule(".prose .embed-frame")!
    expect(frame).toMatch(/aspect-ratio:\s*16 \/ 9/)
    expect(frame).toMatch(/background:\s*var\(--color-surface-2\)/)
    expect(frame).toMatch(/border:\s*1px solid var\(--color-border\)/)
  })

  it("loads no image of its own", () => {
    const start = css.indexOf(".prose .embed-frame")
    expect(css.slice(start, css.indexOf(".post-header", start))).not.toMatch(/url\(/)
  })

  it("makes the card and the audio players the right shape", () => {
    expect(rule(".prose .embed-frame.is-card")).toMatch(/aspect-ratio:\s*auto/)
    expect(rule(".prose .embed-frame.is-compact")).toMatch(/aspect-ratio:\s*auto/)
    expect(rule(".prose .embed-frame.is-compact.is-loaded")).toMatch(/height:\s*166px/)
  })

  it("fills the frame with the player, and shows where focus went", () => {
    expect(rule(".prose .embed-frame.is-loaded iframe")).toMatch(/width:\s*100%/)
    expect(rule(".prose .embed-frame.is-loaded iframe")).toMatch(/border:\s*0/)
    expect(rule(".prose .embed-frame.is-loaded:focus")).toMatch(/outline:\s*2px solid var\(--color-focus\)/)
  })

  it("lets a phone's placeholder grow with its text", () => {
    const phone = /@media \(max-width: 480px\)\s*\{([\s\S]*?)\n\}/.exec(css.slice(css.indexOf(".prose .embed-frame")))?.[1] ?? ""
    expect(phone).toMatch(/aspect-ratio:\s*auto/)
  })
})
