import { describe, expect, it } from "vitest"
import {
  acceptsChild,
  buttonHrefFromInput,
  columnsLayoutFor,
  columnWidths,
  containerRule,
  isBlockNode,
  isFlowType,
  isStandaloneFlowType,
  nearestSpacerSize,
  normalizeButtonHref,
  normalizeButtonLabel,
  normalizeSpacerSize,
  SPACER_SIZES,
  spacerHeight,
  spacerPx,
  stepSpacerSize,
  validateBlock,
} from "."
import vectors from "./buttonHrefVectors.json"

// The layout blocks' shared rules (#426). `buttonHrefVectors.json` is the API's too
// (api/post_blocks_layout_test.go), so the editor and the sanitizer refuse the same hrefs.

describe("button hrefs (buttonHrefVectors.json, shared with the API)", () => {
  it.each(vectors.allowed)("keeps %j", (href) => {
    expect(normalizeButtonHref(href)).toBe(href.trim())
  })
  it.each(vectors.refused)("refuses %j", (href) => {
    expect(normalizeButtonHref(href)).toBeNull()
  })
  it("treats no link as none, and caps the length", () => {
    expect(normalizeButtonHref("")).toBeNull()
    expect(normalizeButtonHref("   ")).toBeNull()
    expect(normalizeButtonHref(null)).toBeNull()
    expect(normalizeButtonHref(42)).toBeNull()
    expect(normalizeButtonHref(`/${"a".repeat(2048)}`)).toBeNull()
    // In code points, as the API counts.
    expect(normalizeButtonHref(`/${"😀".repeat(2047)}`)).not.toBeNull()
  })
})

describe("the Link field", () => {
  it("clears on empty, keeps a path, and adds https:// to a bare domain as the link dialog does", () => {
    expect(buttonHrefFromInput("  ")).toEqual({ href: null })
    expect(buttonHrefFromInput("/changelog")).toEqual({ href: "/changelog" })
    expect(buttonHrefFromInput("example.com/docs")).toEqual({ href: "https://example.com/docs" })
    expect(buttonHrefFromInput("example.com:8080/docs")).toEqual({ href: "https://example.com:8080/docs" })
    expect(buttonHrefFromInput("mailto:ana@example.com")).toEqual({ href: "mailto:ana@example.com" })
  })
  it("says why for anything that isn't a safe link", () => {
    expect(buttonHrefFromInput("javascript:alert(1)")).toHaveProperty("error")
    expect(buttonHrefFromInput("data:text/html,x")).toHaveProperty("error")
    expect(buttonHrefFromInput("foo:bar")).toHaveProperty("error")
  })
})

describe("the columns' layout", () => {
  it("applies a split only with exactly two columns", () => {
    expect(columnsLayoutFor("33-67", 2)).toBe("33-67")
    expect(columnsLayoutFor("33-67", 3)).toBe("equal")
    expect(columnsLayoutFor("nonsense", 2)).toBe("equal")
    expect(columnWidths("33-67", 2)).toEqual([1 / 3, 2 / 3])
    expect(columnWidths("67-33", 2)).toEqual([2 / 3, 1 / 3])
    expect(columnWidths("equal", 4)).toEqual([0.25, 0.25, 0.25, 0.25])
  })
})

describe("the nesting table's new rows", () => {
  it("columns: 2 to 4 columns, at the top or in a group, never in a column or a details", () => {
    expect(containerRule("columns")).toMatchObject({ min: 2, max: 4, topLevel: true })
    expect(acceptsChild("columns", "column")).toBe(true)
    expect(acceptsChild("columns", "paragraph")).toBe(false)
    expect(acceptsChild("group", "columns")).toBe(true)
    expect(acceptsChild("column", "columns")).toBe(false)
    expect(acceptsChild("details", "columns")).toBe(false)
  })
  it("column: flow and details only, no group (design 7), and only inside columns", () => {
    expect(containerRule("column")).toMatchObject({ min: 1, topLevel: false })
    for (const type of ["paragraph", "image", "buttons", "spacer", "details", "theme:example/alert"]) expect(acceptsChild("column", type), type).toBe(true)
    for (const type of ["group", "column", "columns", "list_item"]) expect(acceptsChild("column", type), type).toBe(false)
    expect(acceptsChild("group", "column")).toBe(false)
  })
  it("a button is a part, not a block", () => {
    expect(isBlockNode("button", "buttons")).toBe(false)
    expect(isBlockNode("buttons", "doc")).toBe(true)
    expect(isBlockNode("buttons", "column")).toBe(true)
    expect(isBlockNode("paragraph", "column")).toBe(true)
  })
  it("buttons and spacer are flow, kept out of another block's content", () => {
    for (const type of ["buttons", "spacer"]) {
      expect(isFlowType(type), type).toBe(true)
      expect(isStandaloneFlowType(type), type).toBe(true)
    }
  })
})

describe("the spacer's steps", () => {
  it("are the theme's scale, as a custom property with the default's px as fallback", () => {
    expect(SPACER_SIZES).toEqual(["5", "7", "8", "9"])
    expect(spacerHeight("8")).toBe("var(--space-8, 64px)")
    expect(spacerPx("9")).toBe(96)
  })
  it("reads anything else as the default, 48 px", () => {
    expect(normalizeSpacerSize("13")).toBe("7")
    expect(normalizeSpacerSize(48)).toBe("7")
    expect(spacerHeight("48px")).toBe("var(--space-7, 48px)")
  })
  it("moves one step and stops at the ends", () => {
    expect(stepSpacerSize("7", 1)).toBe("8")
    expect(stepSpacerSize("7", -1)).toBe("5")
    expect(stepSpacerSize("9", 1)).toBe("9")
    expect(stepSpacerSize("5", -1)).toBe("5")
  })
  it("snaps a dragged height to the nearest step", () => {
    expect(nearestSpacerSize(10)).toBe("5")
    expect(nearestSpacerSize(55)).toBe("7")
    expect(nearestSpacerSize(200)).toBe("9")
  })
})

describe("button labels", () => {
  it("are plain text, trimmed and capped", () => {
    expect(normalizeButtonLabel(" Go\nnow ")).toBe("Go now")
    expect([...normalizeButtonLabel("a".repeat(300))].length).toBe(200)
    expect(normalizeButtonLabel(1)).toBe("")
  })
})

describe("Zod", () => {
  const base = { id: "blk-0426-000001", version: 1 }
  it("accepts what the bridge writes", () => {
    expect(() => validateBlock({ ...base, type: "columns", attrs: { layout: "33-67", align: "wide" }, children: ["a-000000001", "a-000000002"] })).not.toThrow()
    expect(() => validateBlock({ ...base, type: "column", attrs: {}, children: ["a-000000001"] })).not.toThrow()
    expect(() => validateBlock({ ...base, type: "spacer", attrs: { size: "9" } })).not.toThrow()
    expect(() =>
      validateBlock({ ...base, type: "buttons", attrs: { align: "center", text: "Go", pm: { type: "buttons", content: [{ type: "button", attrs: { href: "/a", variant: "secondary" }, content: [{ type: "text", text: "Go" }] }] } } }),
    ).not.toThrow()
  })
  it("refuses a value outside its list and an unsafe href", () => {
    expect(() => validateBlock({ ...base, type: "columns", attrs: { layout: "10-90" }, children: [] })).toThrow()
    expect(() => validateBlock({ ...base, type: "spacer", attrs: { size: "48px" } })).toThrow()
    expect(() => validateBlock({ ...base, type: "buttons", attrs: { align: "right", pm: { type: "buttons", content: [{ type: "button" }] } } })).toThrow()
    expect(() => validateBlock({ ...base, type: "buttons", attrs: { pm: { type: "buttons", content: [{ type: "button", attrs: { href: "javascript:alert(1)" } }] } } })).toThrow()
    expect(() => validateBlock({ ...base, type: "buttons", attrs: { pm: { type: "buttons", content: [] } } })).toThrow()
  })
})
