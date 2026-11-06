import { describe, expect, it } from "vitest"
import { pageLayoutVariant, postLayoutCandidates } from "./themeLayout"

// A page's template (#336) resolves against this build's layouts: its own when the
// active theme has it, else the type's variant, else "default".

const load = async () => ({ default: () => null })
const glob = {
  "../t/default/layouts/page/default.astro": load,
  "../t/default/layouts/page/fullwidth.astro": load,
  "../t/minimal/layouts/page/default.astro": load,
  "../t/minimal/layouts/post/sidebar.astro": load,
}

describe("pageLayoutVariant", () => {
  it("uses the page's template when the active theme has it", () => {
    expect(pageLayoutVariant(glob, "../t", "default", "fullwidth", "default")).toBe("fullwidth")
  })

  it("falls back to the default after a switch to a theme without it", () => {
    expect(pageLayoutVariant(glob, "../t", "minimal", "fullwidth", "default")).toBe("default")
  })

  it("follows the type's variant when the page has none, if it's a page layout", () => {
    expect(pageLayoutVariant(glob, "../t", "default", "", "fullwidth")).toBe("fullwidth")
    expect(pageLayoutVariant(glob, "../t", "default", undefined, "fullwidth")).toBe("fullwidth")
    // A post layout of that name isn't a page layout: never render a page with it.
    expect(pageLayoutVariant(glob, "../t", "minimal", "", "sidebar")).toBe("default")
  })

  it("never builds a path from a name that isn't a template", () => {
    expect(pageLayoutVariant({ ...glob, "../t/default/layouts/page/../post/x.astro": load }, "../t", "default", "../post/x", "default")).toBe("default")
  })

  it("is what the post route's chain starts from", () => {
    expect(postLayoutCandidates("../t", "minimal", "page", pageLayoutVariant(glob, "../t", "minimal", "fullwidth", "default"))[0]).toBe(
      "../t/minimal/layouts/page/default.astro"
    )
  })
})
