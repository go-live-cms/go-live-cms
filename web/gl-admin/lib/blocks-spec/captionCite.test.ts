import { describe, it, expect } from "vitest"
import { CITE_MAX_LENGTH, normalizeCite, validateBlock, validateBlockDoc, zBlockquote, zImage } from "./index"

// Image caption + width and quote citation (#346): image and blockquote v2.

const id = "00000000-0000-4000-8000-000000000346"
const image = (attrs: Record<string, unknown>, version: unknown = 2) => ({ id, type: "image", version, attrs: { src: "/m/a.png", ...attrs } })
const quote = (attrs: Record<string, unknown>, version: unknown = 2) => ({ id, type: "blockquote", version, attrs: { text: "q", ...attrs } })
const caption = [
  { type: "text", text: "Photo by " },
  { type: "text", text: "Ada", marks: [{ type: "bold" }, { type: "link", attrs: { href: "https://example.com" } }] },
  { type: "text", text: ", 2026", marks: [{ type: "italic" }] },
]

describe("image v2 (#346)", () => {
  it("accepts a caption with bold, italic and link runs, and every width", () => {
    for (const align of ["inline", "wide", "full"]) {
      expect(zImage.safeParse(image({ caption, align })).success).toBe(true)
    }
  })

  it("still accepts an old v1 image without the new attrs", () => {
    expect(() => validateBlock(image({ alt: "x", mediaId: 4 }, 1))).not.toThrow()
  })

  it("rejects an unknown width", () => {
    expect(zImage.safeParse(image({ align: "huge" })).success).toBe(false)
    expect(zImage.safeParse(image({ align: 2 })).success).toBe(false)
    // A known type never falls back to the custom catch-all (#214).
    expect(() => validateBlock(image({ align: "left" }))).toThrow()
  })

  it("rejects caption marks other than bold, italic and link", () => {
    for (const mark of ["underline", "strike", "code", "highlight"]) {
      expect(zImage.safeParse(image({ caption: [{ type: "text", text: "x", marks: [{ type: mark }] }] })).success).toBe(false)
    }
  })

  it("rejects a caption that isn't text runs", () => {
    expect(zImage.safeParse(image({ caption: "plain string" })).success).toBe(false)
    expect(zImage.safeParse(image({ caption: [{ type: "hardBreak" }] })).success).toBe(false)
    expect(zImage.safeParse(image({ caption: [{ type: "text", text: "" }] })).success).toBe(false)
  })

  it("rejects a version it doesn't know", () => {
    expect(zImage.safeParse(image({}, 3)).success).toBe(false)
  })

  it("keeps the input as given (no stripped copy)", () => {
    const block = image({ caption, align: "wide" })
    expect(validateBlock(block)).toBe(block)
  })
})

describe("blockquote v2 (#346)", () => {
  it("accepts a plain-text cite up to the cap, counted in code points", () => {
    expect(zBlockquote.safeParse(quote({ cite: "Ursula K. Le Guin" })).success).toBe(true)
    expect(zBlockquote.safeParse(quote({ cite: "😀".repeat(CITE_MAX_LENGTH) })).success).toBe(true)
  })

  it("rejects an overlong or non-string cite", () => {
    expect(zBlockquote.safeParse(quote({ cite: "x".repeat(CITE_MAX_LENGTH + 1) })).success).toBe(false)
    expect(zBlockquote.safeParse(quote({ cite: 42 })).success).toBe(false)
    expect(zBlockquote.safeParse(quote({ cite: { text: "x" } })).success).toBe(false)
  })

  it("still accepts an old v1 quote", () => {
    expect(() => validateBlock(quote({}, 1))).not.toThrow()
  })

  it("validates inside a doc", () => {
    const doc = { doc_version: 1, blocks_order: [id], blocks: { [id]: quote({ cite: "x".repeat(CITE_MAX_LENGTH + 1) }) } }
    expect(() => validateBlockDoc(doc)).toThrow()
  })
})

describe("normalizeCite", () => {
  it("trims, caps at CITE_MAX_LENGTH code points, and maps empty to null", () => {
    expect(normalizeCite("  Ada  ")).toBe("Ada")
    expect(normalizeCite("   ")).toBeNull()
    expect(normalizeCite(undefined)).toBeNull()
    expect(normalizeCite(7)).toBeNull()
    expect([...normalizeCite("😀".repeat(CITE_MAX_LENGTH + 5))!].length).toBe(CITE_MAX_LENGTH)
  })
})
