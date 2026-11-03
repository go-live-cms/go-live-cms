import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import {
  articleJsonLd,
  firstParagraphText,
  homeTitle,
  jsonLdText,
  pageTitle,
  postCanonical,
  postDescription,
  postExcerpt,
} from "./seo"

// A post's SEO on the public site (#357): the title format, the description and
// excerpt fallbacks, the canonical URL and the Article JSON-LD.

function doc(...blocks: { type: string; attrs: Record<string, unknown> }[]): BlockDocV1 {
  const ids = blocks.map((_, i) => `block-000000${i}`)
  return {
    doc_version: 1,
    blocks_order: ids,
    blocks: Object.fromEntries(blocks.map((b, i) => [ids[i], { id: ids[i], version: 1, ...b }])),
  } as unknown as BlockDocV1
}

const body = doc(
  { type: "heading", attrs: { level: 2, text: "Not a paragraph" } },
  { type: "paragraph", attrs: { text: "   " } },
  {
    type: "paragraph",
    attrs: { pm: { type: "paragraph", content: [{ type: "text", text: "Until this release, " }, { type: "text", text: "two people", marks: [{ type: "bold" }] }, { type: "text", text: " lost changes." }] } },
  },
  { type: "paragraph", attrs: { text: "Second paragraph." } },
)

describe("pageTitle", () => {
  it("is the SEO title or post title, then the site name", () => {
    expect(pageTitle("Real-time collaboration", "GoLive Blog")).toBe("Real-time collaboration · GoLive Blog")
    expect(pageTitle("  Spaced  ", "Site")).toBe("Spaced · Site")
  })
  it("has no separator without a site name, and no repeat when they're equal", () => {
    expect(pageTitle("Hello", "")).toBe("Hello")
    expect(pageTitle("Hello", null)).toBe("Hello")
    expect(pageTitle("GoLive", "GoLive")).toBe("GoLive")
    expect(pageTitle("", "GoLive")).toBe("GoLive")
  })
})

describe("homeTitle", () => {
  it("is the site name, with the tagline when there is one", () => {
    expect(homeTitle("Field Notes", "Notes from the team")).toBe("Field Notes · Notes from the team")
    expect(homeTitle("Field Notes", "")).toBe("Field Notes")
    expect(homeTitle("Field Notes", null)).toBe("Field Notes")
  })
})

describe("firstParagraphText", () => {
  it("is the first non-empty top-level paragraph, from its text or its PM JSON", () => {
    expect(firstParagraphText(body)).toBe("Until this release, two people lost changes.")
    expect(firstParagraphText(doc({ type: "paragraph", attrs: { text: "Plain  text\nhere" } }))).toBe("Plain text here")
  })
  it("is empty without a body or a paragraph", () => {
    expect(firstParagraphText(undefined)).toBe("")
    expect(firstParagraphText({} as BlockDocV1)).toBe("")
    expect(firstParagraphText(doc({ type: "heading", attrs: { text: "Only a heading" } }))).toBe("")
  })
})

describe("postDescription and postExcerpt", () => {
  const long = "word ".repeat(60).trim()

  it("prefers the SEO description, then the excerpt, then the first paragraph", () => {
    const post = { description: "<p>The excerpt</p>", published_blocks: body }
    expect(postDescription(post, { description: "The SEO description" })).toBe("The SEO description")
    expect(postDescription(post, { description: "  " })).toBe("The excerpt")
    expect(postDescription(post, null)).toBe("The excerpt")
    expect(postDescription({ description: "", published_blocks: body }, { description: "" })).toBe("Until this release, two people lost changes.")
    expect(postDescription({ description: "", published_blocks: undefined })).toBe("")
  })

  it("cuts each at a word before 160 characters", () => {
    const cut = postDescription({ description: "", published_blocks: doc({ type: "paragraph", attrs: { text: long } }) })
    expect(cut.length).toBeLessThanOrEqual(160)
    expect(cut.endsWith("…")).toBe(true)
    expect(postDescription({ description: "" }, { description: long }).length).toBeLessThanOrEqual(160)
  })

  it("lists use a longer excerpt, but the first paragraph still stops at 160", () => {
    expect(postExcerpt({ description: long }, 220).length).toBeGreaterThan(160)
    const fromBody = postExcerpt({ description: "", published_blocks: doc({ type: "paragraph", attrs: { text: long } }) }, 220)
    expect(fromBody.length).toBeLessThanOrEqual(160)
  })
})

describe("postCanonical", () => {
  it("is the SEO canonical URL when it's an absolute http(s) URL, else the post's own path", () => {
    expect(postCanonical("/post/hello", { canonical_url: "https://example.com/original" })).toBe("https://example.com/original")
    expect(postCanonical("/post/hello", { canonical_url: "" })).toBe("/post/hello")
    expect(postCanonical("/post/hello", null)).toBe("/post/hello")
    expect(postCanonical("/post/hello", { canonical_url: "javascript:alert(1)" })).toBe("/post/hello")
    expect(postCanonical("/post/hello", { canonical_url: "example.com/x" })).toBe("/post/hello")
  })
})

describe("articleJsonLd", () => {
  it("builds an Article with headline, dates, authors and image", () => {
    const ld = articleJsonLd({
      headline: "Hello",
      description: "An excerpt",
      url: "https://example.org/post/hello",
      image: "https://example.org/uploads/media/_variants/a.jpg/social.jpg",
      datePublished: "2026-10-01T10:00:00.000Z",
      dateModified: "2026-10-02T10:00:00.000Z",
      authors: [{ name: "Ana Costa", url: "https://example.org/author/ana" }, { name: "" }],
      publisher: "Field Notes",
    })
    expect(ld).toEqual({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "Hello",
      description: "An excerpt",
      mainEntityOfPage: "https://example.org/post/hello",
      image: ["https://example.org/uploads/media/_variants/a.jpg/social.jpg"],
      datePublished: "2026-10-01T10:00:00.000Z",
      dateModified: "2026-10-02T10:00:00.000Z",
      author: [{ "@type": "Person", name: "Ana Costa", url: "https://example.org/author/ana" }],
      publisher: { "@type": "Organization", name: "Field Notes" },
    })
  })

  it("leaves out what it doesn't know", () => {
    expect(articleJsonLd({ headline: "x", url: "https://e.org/p/1" })).toEqual({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "x",
      mainEntityOfPage: "https://e.org/p/1",
    })
  })

  it("is serialized so no value can close the script element", () => {
    const text = jsonLdText(articleJsonLd({ headline: "</script><script>alert(1)</script>", url: "https://e.org/" }))
    expect(text).not.toContain("</script")
    expect(JSON.parse(text).headline).toBe("</script><script>alert(1)</script>")
  })
})
