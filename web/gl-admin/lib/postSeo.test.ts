import { describe, expect, it } from "vitest"
import {
  EMPTY_SEO,
  canonicalUrlError,
  firstParagraphFromHtml,
  previewAddress,
  sameSeo,
  seoFallbacks,
  seoFromPost,
  seoPayload,
  seoSaveable,
  softCount,
} from "./postSeo"

// The SEO tab's rules (#357): fallbacks, soft guides, the canonical URL check and
// the saved body.

describe("softCount", () => {
  it("counts code points and says when the guide is passed, without refusing anything", () => {
    expect(softCount("Hello", 60)).toEqual({ count: 5, guide: 60, over: false, spoken: "5 of 60 characters" })
    expect(softCount("😀".repeat(60), 60).over).toBe(false)
    const over = softCount("a".repeat(72), 60)
    expect(over.over).toBe(true)
    expect(over.spoken).toBe("72 of 60 characters. Search results may cut it off.")
  })
})

describe("seoFallbacks", () => {
  const base = { seo: EMPTY_SEO, postTitle: "Shipping real-time collaboration", excerpt: "Two people can now edit one post.", firstParagraph: "Until this release..." }

  it("an empty tab borrows the post title and the excerpt", () => {
    const f = seoFallbacks(base)
    expect(f.title).toBe("Shipping real-time collaboration")
    expect(f.titleHint).toBe("Uses the post title")
    expect(f.description).toBe("Two people can now edit one post.")
    expect(f.descriptionPlaceholder).toBe("Two people can now edit one post.")
    expect(f.descriptionHint).toBe("Uses the excerpt")
  })

  it("without an excerpt, the first paragraph, cut at a word before 160", () => {
    const first = "word ".repeat(50).trim()
    const f = seoFallbacks({ ...base, excerpt: "", firstParagraph: first })
    expect(f.descriptionHint).toBe("Uses the first paragraph")
    expect(f.description.length).toBeLessThanOrEqual(160)
    expect(f.descriptionPlaceholder).toBe(first)
    expect(seoFallbacks({ ...base, excerpt: "", firstParagraph: "" }).descriptionHint).toMatch(/Add an excerpt/)
  })

  it("own values win, with a hint that changes past the guide", () => {
    const f = seoFallbacks({ ...base, seo: { ...EMPTY_SEO, seo_title: "Real-time collaboration in GoLive", seo_description: "Own." } })
    expect(f.title).toBe("Real-time collaboration in GoLive")
    expect(f.titleHint).toBe("Shown in search results and browser tabs.")
    expect(f.description).toBe("Own.")
    expect(f.descriptionHint).toBe("Shown under the title in search results.")
    const over = seoFallbacks({ ...base, seo: { ...EMPTY_SEO, seo_title: "a".repeat(72), seo_description: "b".repeat(190) } })
    expect(over.titleHint).toMatch(/about 60 characters/)
    expect(over.descriptionHint).toMatch(/about 160 characters/)
  })
})

describe("canonicalUrlError", () => {
  it("accepts empty and absolute http(s) URLs", () => {
    for (const ok of ["", "  ", "https://blog.golive.dev/guides/collaboration", "http://example.com:8080/a?b#c"]) {
      expect(canonicalUrlError(ok)).toBeNull()
    }
  })
  it("refuses what the API refuses, with the fix in the message", () => {
    expect(canonicalUrlError("blog.golive.dev/guides collaboration")).toBe(
      "“blog.golive.dev/guides collaboration” isn’t a complete URL. Start it with https:// and remove any spaces."
    )
    for (const bad of ["/post/1", "ftp://x.org", "javascript:alert(1)", "https:example.com", "https://a b.com", "https://u:p@x.org", "https://"]) {
      expect(canonicalUrlError(bad), bad).not.toBeNull()
    }
  })
})

describe("saving", () => {
  it("sends every field, trimmed and on one line", () => {
    expect(
      seoPayload({ seo_title: " A\ntitle ", seo_description: " d ", social_image_id: 4, noindex: true, canonical_url: " https://x.org/ " })
    ).toEqual({ seo_title: "A title", seo_description: "d", social_image_id: 4, noindex: true, canonical_url: "https://x.org/" })
  })
  it("compares after trimming, so whitespace alone isn't a change", () => {
    expect(sameSeo(EMPTY_SEO, { ...EMPTY_SEO, seo_title: "  " })).toBe(true)
    expect(sameSeo(EMPTY_SEO, { ...EMPTY_SEO, noindex: true })).toBe(false)
    expect(sameSeo(EMPTY_SEO, { ...EMPTY_SEO, social_image_id: 3 })).toBe(false)
  })
  it("waits while the canonical URL is invalid", () => {
    expect(seoSaveable({ ...EMPTY_SEO, canonical_url: "nope" })).toBe(false)
    expect(seoSaveable({ ...EMPTY_SEO, canonical_url: "https://x.org" })).toBe(true)
  })
  it("reads the post's SEO, defaults when an older API sends none", () => {
    expect(seoFromPost(undefined)).toEqual(EMPTY_SEO)
    expect(seoFromPost({ seo: { ...EMPTY_SEO, noindex: true } }).noindex).toBe(true)
  })
})

describe("firstParagraphFromHtml", () => {
  it("is the first paragraph with text, as plain text", () => {
    expect(firstParagraphFromHtml('<h2>Title</h2><p data-block-id="x"></p><p>Until <strong>this</strong> &amp; that.</p><p>Next</p>')).toBe(
      "Until this & that."
    )
    expect(firstParagraphFromHtml("<h2>Only a heading</h2>")).toBe("")
    expect(firstParagraphFromHtml(undefined)).toBe("")
  })
})

describe("previewAddress", () => {
  it("is the host and the path's segments", () => {
    expect(previewAddress("https://blog.golive.dev", "/post/real-time-collaboration")).toBe("blog.golive.dev › post › real-time-collaboration")
    expect(previewAddress("https://blog.golive.dev", "")).toBe("blog.golive.dev")
  })
})
