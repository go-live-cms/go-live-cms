// @vitest-environment node
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// The default theme's inline marks (#418, "Published · text · 1280"): a highlight in the
// theme's highlight token (its contrast with the text: tokens.test.ts, both palettes), a
// link in it in the text colour, and superscript/subscript that don't open up the line.

const css = readFileSync(path.resolve(__dirname, "styles/theme.css"), "utf8")

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const body = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1]
  if (body === undefined) throw new Error(`no rule for ${selector}`)
  return Object.fromEntries(
    body
      .split(";")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]),
  )
}

describe("default theme inline marks (#418)", () => {
  it("highlights with the highlight token, text in the text colour, links too", () => {
    expect(rule(".prose mark")).toMatchObject({ background: "var(--color-highlight)", color: "var(--color-text)" })
    expect(rule(".prose mark a")).toMatchObject({ color: "var(--color-text)" })
  })

  it("sets superscript and subscript without changing the line height", () => {
    expect(rule(".prose :is(sup, sub)")).toMatchObject({ "line-height": "0", "vertical-align": "baseline", position: "relative" })
    expect(rule(".prose sup")).toMatchObject({ top: "-0.5em" })
    expect(rule(".prose sub")).toMatchObject({ bottom: "-0.25em" })
  })
})
