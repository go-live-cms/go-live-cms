import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { EMPTY_HEADING_SLUG, headingAnchors, headingText, slugifyHeading, tableOfContents, type HeadingAnchor } from "./headingAnchors"

type Spec = { id: string; type?: string; level?: number; text?: string; content?: unknown[] }

const t = (text: string) => ({ type: "text", text })

function doc(...specs: Spec[]): BlockDocV1 {
  const out = { doc_version: 1, blocks_order: [] as string[], blocks: {} as Record<string, unknown> }
  for (const s of specs) {
    const type = s.type ?? "heading"
    out.blocks_order.push(s.id)
    const content = s.content ?? (s.text !== undefined && s.text !== "" ? [t(s.text)] : undefined)
    out.blocks[s.id] = {
      id: s.id,
      type,
      version: 1,
      attrs: { level: s.level ?? 2, pm: { type, attrs: { level: s.level ?? 2 }, ...(content ? { content } : {}) } },
    }
  }
  return out as unknown as BlockDocV1
}

const h = (id: string, text: string, level = 2): Spec => ({ id, text, level })

describe("slugifyHeading", () => {
  it("lower-cases and joins words with single dashes", () => {
    expect(slugifyHeading("How it works")).toBe("how-it-works")
    expect(slugifyHeading("  What’s next?!  ")).toBe("what-s-next")
    expect(slugifyHeading("Step 1 -- 2 / 3")).toBe("step-1-2-3")
  })

  it("drops Latin accents", () => {
    expect(slugifyHeading("Café crème brûlée")).toBe("cafe-creme-brulee")
    expect(slugifyHeading("Ångström İstanbul Ærø")).toBe("angstrom-istanbul-ærø")
    expect(slugifyHeading("Ελληνικά")).toBe("ελληνικα")
  })

  it("keeps the letters of other scripts", () => {
    expect(slugifyHeading("日本語の見出し")).toBe("日本語の見出し")
    expect(slugifyHeading("한국어 제목")).toBe("한국어-제목")
    expect(slugifyHeading("Привет, мир")).toBe("привет-мир")
    // Devanagari vowel signs are combining marks but part of the word.
    expect(slugifyHeading("हिन्दी शीर्षक")).toBe("हिन्दी-शीर्षक")
    expect(slugifyHeading("مرحبا بالعالم")).toBe("مرحبا-بالعالم")
  })

  it("gives the same slug for the same text in either Unicode form", () => {
    const composed = "Café"
    const decomposed = "Café"
    expect(slugifyHeading(decomposed)).toBe(slugifyHeading(composed))
  })

  it("falls back for headings with nothing to slug", () => {
    expect(slugifyHeading("")).toBe(EMPTY_HEADING_SLUG)
    expect(slugifyHeading("   ")).toBe(EMPTY_HEADING_SLUG)
    expect(slugifyHeading("?!…")).toBe(EMPTY_HEADING_SLUG)
    expect(slugifyHeading("🎉🎉")).toBe(EMPTY_HEADING_SLUG)
  })

  it("caps long slugs without a trailing dash or a split character", () => {
    const slug = slugifyHeading(`${"word ".repeat(30)}end`)
    expect(slug.length).toBeLessThanOrEqual(80)
    expect(slug.endsWith("-")).toBe(false)
    // U+20000, a CJK letter outside the BMP (two UTF-16 units, no decomposition).
    const astral = slugifyHeading("\u{20000}".repeat(100))
    expect(Array.from(astral)).toHaveLength(80)
    expect(astral).not.toMatch(/[\ud800-\udbff]$/)
  })
})

describe("headingText", () => {
  it("joins text nodes and turns hard breaks into spaces", () => {
    const [block] = Object.values(doc({ id: "a", content: [t("Hello "), { type: "text", text: "bold", marks: [{ type: "bold" }] }, { type: "hardBreak" }, t("world")] }).blocks)
    expect(headingText(block as never)).toBe("Hello bold world")
  })

  it("reads attrs.text when there is no ProseMirror content", () => {
    expect(headingText({ id: "x", type: "heading", version: 1, attrs: { level: 2, text: "  Plain   text " } } as never)).toBe("Plain text")
  })
})

describe("headingAnchors", () => {
  it("lists headings in reading order and skips other blocks", () => {
    const d = doc(h("a", "Intro"), { id: "p", type: "paragraph", text: "Body" }, h("b", "Details", 3))
    expect(headingAnchors(d)).toEqual([
      { blockId: "a", id: "intro", level: 2, text: "Intro" },
      { blockId: "b", id: "details", level: 3, text: "Details" },
    ])
  })

  it("numbers duplicates in order, never reusing an id", () => {
    const d = doc(h("a", "Setup"), h("b", "Setup"), h("c", "setup!"), h("d", "Setup 2"), h("e", ""), h("f", ""))
    expect(headingAnchors(d).map((a) => a.id)).toEqual(["setup", "setup-2", "setup-3", "setup-2-2", "section", "section-2"])
  })

  it("is stable: the same doc gives the same ids every time", () => {
    const d = doc(h("a", "Café"), h("b", "Cafe"), h("c", "日本"))
    expect(headingAnchors(d)).toEqual(headingAnchors(JSON.parse(JSON.stringify(d))))
    expect(headingAnchors(d).map((a) => a.id)).toEqual(["cafe", "cafe-2", "日本"])
  })

  it("avoids reserved ids", () => {
    const d = doc(h("a", "Content"), h("b", "More to read"))
    expect(headingAnchors(d, ["content", "more-to-read"]).map((a) => a.id)).toEqual(["content-2", "more-to-read-2"])
  })

  it("follows blocks_order once per id and ignores missing blocks", () => {
    const d = doc(h("a", "One"), h("b", "Two"))
    d.blocks_order = ["b", "a", "b", "ghost"]
    expect(headingAnchors(d).map((a) => [a.blockId, a.id])).toEqual([
      ["b", "two"],
      ["a", "one"],
    ])
  })

  it("is empty for no doc", () => {
    expect(headingAnchors(undefined)).toEqual([])
    expect(headingAnchors(null)).toEqual([])
    expect(headingAnchors({} as never)).toEqual([])
  })
})

describe("tableOfContents", () => {
  const anchors = (...specs: Spec[]): HeadingAnchor[] => headingAnchors(doc(...specs))

  it("nests H3s under the H2 before them", () => {
    expect(tableOfContents(anchors(h("a", "One"), h("b", "One A", 3), h("c", "One B", 3), h("d", "Two")))).toEqual([
      {
        id: "one",
        text: "One",
        children: [
          { id: "one-a", text: "One A", children: [] },
          { id: "one-b", text: "One B", children: [] },
        ],
      },
      { id: "two", text: "Two", children: [] },
    ])
  })

  it("keeps an H3 before the first H2 at the top level", () => {
    expect(tableOfContents(anchors(h("a", "Lead", 3), h("b", "One"), h("c", "Two"))).map((e) => e.id)).toEqual(["lead", "one", "two"])
  })

  it("leaves out H1 and H4+ and headings without text", () => {
    const toc = tableOfContents(anchors(h("a", "Title", 1), h("b", "One"), h("c", "Deep", 4), h("d", ""), h("e", "Two"), h("f", "Three")))
    expect(toc.map((e) => e.id)).toEqual(["one", "two", "three"])
    expect(toc[0].children).toEqual([])
  })

  it("is empty below three entries (counting nested ones)", () => {
    expect(tableOfContents(anchors(h("a", "One"), h("b", "Two")))).toEqual([])
    expect(tableOfContents(anchors(h("a", "One"), h("b", "Deep", 4), h("c", "Title", 1)))).toEqual([])
    expect(tableOfContents(anchors(h("a", "One"), h("b", "One A", 3), h("c", "One B", 3)))).toHaveLength(1)
    expect(tableOfContents([])).toEqual([])
  })

  it("takes another minimum", () => {
    expect(tableOfContents(anchors(h("a", "One")), 1)).toHaveLength(1)
  })
})
