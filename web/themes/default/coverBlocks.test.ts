import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { COVER_OVERLAY_MAX, COVER_OVERLAY_MIN, COVER_OVERLAY_STEP } from "@gl-admin/lib/blocks-spec"
import themeConfig from "./theme.config"

// Cover and media & text in the default theme (#427, "Published · media & embeds" at 1280
// and 375, light and dark). jsdom has no layout, so this pins the rules that decide the two
// widths, and works out the one number the issue asks about: text on a cover keeps 4.5:1 at
// every overlay step, over the brightest image there is.

const css = readFileSync(resolve(__dirname, "styles/theme.css"), "utf8")

function rule(selector: string, from = 0): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`(?:^|\\n|})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css.slice(from))
  return match?.[1] ?? ""
}

function luminance(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function contrast(foreground: number, background: number): number {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}

const overlaySteps = (() => {
  const steps: number[] = []
  for (let value = COVER_OVERLAY_MIN; value <= COVER_OVERLAY_MAX; value += COVER_OVERLAY_STEP) steps.push(value)
  return steps
})()

describe("text on a cover (4.5:1 with the overlay)", () => {
  const scrim = /--cover-scrim: max\(0, calc\(1 - ([0-9.]+) \/ \(1 - var\(--dim, 0\.55\)\)\)\)/.exec(css)

  it("is white in both palettes: the overlay is black, so it doesn't follow the theme", () => {
    expect(rule(".cover")).toContain("color: #ffffff")
    expect(rule(".site .prose .cover-inner a:not(.btn):hover")).toContain("color: #ffffff")
    expect(themeConfig.colors?.light).toBeDefined()
    expect(themeConfig.colors?.dark).toBeDefined()
  })

  it("has a scrim the theme can compute from the overlay", () => {
    expect(scrim).not.toBeNull()
    expect(rule(".cover-inner::before")).toContain("background: rgb(0 0 0 / var(--cover-scrim))")
    // One layer behind the text, reaching a little past the letters.
    expect(rule(".cover-inner::before")).toContain("inset: calc(-1 * var(--space-4))")
    expect(rule(".cover-inner::before")).toContain("z-index: -1")
  })

  it.each(overlaySteps)("at a %d%% overlay, white text passes over a pure white image", (overlay) => {
    const dim = overlay / 100
    const keep = Number(scrim![1])
    const alpha = Math.max(0, 1 - keep / (1 - dim))
    // What the page paints behind a white letter on a white image: the overlay, then the scrim.
    const behind = 255 * (1 - dim) * (1 - alpha)
    expect(contrast(255, behind)).toBeGreaterThanOrEqual(4.5)
  })

  it("adds nothing at 55% or above, as drawn", () => {
    const keep = Number(scrim![1])
    for (const overlay of overlaySteps.filter((value) => value >= 55)) {
      expect(Math.max(0, 1 - keep / (1 - overlay / 100)), `${overlay}`).toBe(0)
    }
  })

  it("the overlay itself is drawn from --dim, which the block sets", () => {
    expect(rule(".cover::before")).toContain("background: rgb(0 0 0 / var(--dim, 0.55))")
  })

  it("the theme's own surfaces keep the theme's text", () => {
    expect(css).toMatch(/\.prose \.cover-inner :is\(\.callout, pre, :not\(pre\) > code, \.embed-frame, \.file-block, \.table-scroll\) \{\s*color: var\(--color-text\)/)
    expect(css).toMatch(/\.prose \.cover-inner :is\(\.file-block, \.table-scroll\) \{\s*background: var\(--color-background\)/)
  })

  it("buttons on a cover read against it: white fill or a white outline", () => {
    expect(rule(".site .cover .btn-primary")).toContain("background: #ffffff")
    expect(rule(".site .cover .btn-primary")).toContain("color: #111110")
    expect(rule(".site .cover .btn-secondary")).toContain("border-color: #ffffff")
    expect(rule(".site .cover .btn-secondary")).toContain("color: #ffffff")
    expect(contrast(0x11, 255)).toBeGreaterThanOrEqual(4.5)
  })

  it("focus stays visible on the image", () => {
    expect(rule(".site .cover :focus-visible")).toContain("outline-color: #ffffff")
  })
})

describe("at 1280", () => {
  it("a cover fills its slot, its image behind, the blocks in the text column", () => {
    const cover = rule(".cover")
    expect(cover).toContain("position: relative")
    expect(cover).toContain("min-height: clamp(380px, 52vw, 560px)")
    expect(cover).toContain("box-sizing: border-box")
    const image = rule(".prose .cover > img")
    expect(image).toContain("position: absolute")
    expect(image).toContain("inset: 0")
    expect(rule(".cover-inner")).toContain("max-width: var(--content-width)")
    expect(rule(".prose .cover.alignfull")).toContain("border-radius: 0")
  })

  it("media & text is two equal columns, the media at either end", () => {
    expect(rule(".media-text")).toContain("display: grid")
    expect(rule(".media-text")).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)")
    expect(rule(".media-text.is-media-right > .media-text-media")).toContain("order: 2")
    expect(rule(".prose .media-text-media img")).toContain("aspect-ratio: 4 / 5")
  })

  it("the blocks inside reset the prose rhythm for themselves", () => {
    expect(rule(".prose .media-text-body > * + *")).toContain("margin-top: 0.8em")
  })
})

describe("at 375", () => {
  const media = css.indexOf("@media (max-width: 640px)", css.indexOf("Media & text (#427)"))

  it("media & text is one column, the media first and shorter", () => {
    expect(media).toBeGreaterThan(-1)
    const block = css.slice(media, css.indexOf("\n}\n", media))
    expect(block).toContain("grid-template-columns: minmax(0, 1fr)")
    expect(block).toContain(".media-text.is-media-right > .media-text-media")
    expect(block).toContain("order: 0")
    expect(block).toContain("aspect-ratio: 3 / 2")
  })

  it("a cover's height doesn't collapse, and its padding comes from the theme's gutter", () => {
    expect(rule(".cover")).toContain("padding: clamp(24px, 5vw, 64px) var(--container-gutter)")
  })
})
