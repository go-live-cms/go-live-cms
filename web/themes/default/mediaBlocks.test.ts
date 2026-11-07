import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// The default theme styles the video, audio and file blocks (#423, "Published · media &
// embeds" at 1280 and 375): players as wide as the text column, a black video box in both
// palettes, a bordered download row that wraps on a phone. The colours come from the theme's
// tokens (tokens.test.ts checks that every var() is defined, in light and dark).

const css = readFileSync(path.resolve("themes/default/styles/theme.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? null
}

describe("the default theme's media blocks (#423)", () => {
  it("makes the players as wide as the text column", () => {
    expect(rule(".prose .video-block video")).toMatch(/width:\s*100%/)
    expect(rule(".prose .video-block video")).toMatch(/aspect-ratio:\s*16 \/ 9/)
    expect(rule(".prose .audio-block audio")).toMatch(/width:\s*100%/)
  })

  it("draws the file row from the tokens", () => {
    const row = rule(".prose .file-block")!
    expect(row).toMatch(/display:\s*flex/)
    expect(row).toMatch(/border:\s*1px solid var\(--color-border\)/)
    expect(rule(".prose .file-meta")).toMatch(/color:\s*var\(--color-text-muted\)/)
    expect(rule(".prose .file-text a")).toMatch(/color:\s*var\(--color-secondary\)/)
  })

  it("wraps the file row on a phone, the Download button full width", () => {
    const phone = /@media \(max-width: 480px\)\s*\{([\s\S]*?)\n\}/.exec(css.slice(css.indexOf(".prose .file-block")))?.[1] ?? ""
    expect(phone).toMatch(/\.prose \.file-block\s*\{\s*flex-wrap:\s*wrap/)
    expect(phone).toMatch(/\.prose \.file-block \.file-download\s*\{\s*width:\s*100%/)
  })
})