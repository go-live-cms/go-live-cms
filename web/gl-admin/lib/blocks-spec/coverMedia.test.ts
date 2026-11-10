import { describe, expect, it } from "vitest"
import {
  capMediaAlt,
  COVER_OVERLAY_DEFAULT,
  coverNodeAttrs,
  coverStoredAttrs,
  focalFromMedia,
  focalPosition,
  isBlockDecorative,
  isCoverMediaNode,
  MEDIA_ALT_MAX_LENGTH,
  mediaTextNodeAttrs,
  mediaTextStoredAttrs,
  moveFocal,
  needsAltText,
  normalizeCoverOverlay,
  normalizeFocal,
  normalizeFocalAxis,
  normalizeMediaAlt,
  validateBlockDoc,
} from "./index"
import vectors from "./coverMediaVectors.json"

// Cover and media & text's rules (#427): the numbers the API clamps the same way (the shared
// vectors), the focal point's keys ("Keyboard": 1%, 10% with Shift), and the node ⇄ stored shapes.

describe("the shared vectors (coverMediaVectors.json, read by the API's tests too)", () => {
  it.each(vectors.overlay)("overlay $in → $want", ({ in: value, want }) => {
    expect(normalizeCoverOverlay(value)).toBe(want)
  })

  it.each(vectors.focal)("focal $in → $want", ({ in: value, want }) => {
    expect(normalizeFocal(value)).toEqual(want)
  })
})

describe("the overlay", () => {
  it("anything but a number is the default", () => {
    for (const value of [undefined, null, "55", true, NaN, Infinity, {}]) expect(normalizeCoverOverlay(value)).toBe(COVER_OVERLAY_DEFAULT)
    expect(COVER_OVERLAY_DEFAULT).toBe(55)
  })
})

describe("the focal point", () => {
  it("one axis: clamped and whole, or null", () => {
    expect(normalizeFocalAxis(50.4)).toBe(50)
    expect(normalizeFocalAxis(-1)).toBe(0)
    expect(normalizeFocalAxis(101)).toBe(100)
    expect(normalizeFocalAxis("50")).toBeNull()
    expect(normalizeFocalAxis(NaN)).toBeNull()
  })

  it("starts from the media's own focal point, whole percent, else the centre", () => {
    expect(focalFromMedia({ x: 0.437, y: 0.8 })).toEqual({ x: 44, y: 80 })
    expect(focalFromMedia(null)).toEqual({ x: 50, y: 50 })
    expect(focalFromMedia(undefined)).toEqual({ x: 50, y: 50 })
  })

  it("arrows move it 1%, Shift 10% (\"Keyboard\" › Focal point)", () => {
    const at = { x: 50, y: 40 }
    expect(moveFocal(at, "ArrowLeft", false)).toEqual({ x: 49, y: 40 })
    expect(moveFocal(at, "ArrowRight", false)).toEqual({ x: 51, y: 40 })
    expect(moveFocal(at, "ArrowUp", false)).toEqual({ x: 50, y: 39 })
    expect(moveFocal(at, "ArrowDown", false)).toEqual({ x: 50, y: 41 })
    expect(moveFocal(at, "ArrowLeft", true)).toEqual({ x: 40, y: 40 })
    expect(moveFocal(at, "ArrowRight", true)).toEqual({ x: 60, y: 40 })
    expect(moveFocal(at, "ArrowUp", true)).toEqual({ x: 50, y: 30 })
    expect(moveFocal(at, "ArrowDown", true)).toEqual({ x: 50, y: 50 })
  })

  it("stops at the edges and ignores every other key", () => {
    expect(moveFocal({ x: 0, y: 100 }, "ArrowLeft", true)).toEqual({ x: 0, y: 100 })
    expect(moveFocal({ x: 95, y: 5 }, "ArrowRight", true)).toEqual({ x: 100, y: 5 })
    expect(moveFocal({ x: 95, y: 5 }, "ArrowUp", true)).toEqual({ x: 95, y: 0 })
    expect(moveFocal({ x: 1, y: 1 }, "Enter", false)).toBeNull()
  })

  it("is an object-position", () => {
    expect(focalPosition({ x: 50, y: 40 })).toBe("50% 40%")
  })
})

describe("alt text", () => {
  it("stored as the API's sanitizer makes it", () => {
    expect(normalizeMediaAlt("  Two\tlines  ")).toBe("Two lines")
    expect(normalizeMediaAlt("   ")).toBeNull()
    expect(normalizeMediaAlt(3)).toBeNull()
    expect(capMediaAlt("é".repeat(300))).toHaveLength(MEDIA_ALT_MAX_LENGTH)
  })

  it("a cover is decorative unless it says otherwise, media & text the reverse", () => {
    expect(isBlockDecorative("cover", undefined)).toBe(true)
    expect(isBlockDecorative("cover", false)).toBe(false)
    expect(isBlockDecorative("media_text", undefined)).toBe(false)
    expect(isBlockDecorative("media_text", true)).toBe(true)
  })

  it("flags a block with no alt text unless it, or its media, is decorative", () => {
    expect(needsAltText("", false, false)).toBe(true)
    expect(needsAltText("   ", false, false)).toBe(true)
    expect(needsAltText(null, false, false)).toBe(true)
    expect(needsAltText("Dunes", false, false)).toBe(false)
    expect(needsAltText("", true, false)).toBe(false)
    expect(needsAltText("", false, true)).toBe(false)
  })
})

describe("node attrs ⇄ Block Spec", () => {
  it("names the nodes", () => {
    expect(isCoverMediaNode("cover")).toBe(true)
    expect(isCoverMediaNode("mediaText")).toBe(true)
    expect(isCoverMediaNode("image")).toBe(false)
  })

  it("a cover: decorative and overlay always, focal as one object, defaults out", () => {
    expect(coverStoredAttrs({ alt: null, decorative: true, focalX: null, focalY: null, overlay: 55, align: "content" })).toEqual({ decorative: true, overlay: 55 })
    expect(coverStoredAttrs({ alt: " Towers ", decorative: false, focalX: 50, focalY: 40, overlay: 40, align: "full" })).toEqual({
      alt: "Towers",
      decorative: false,
      focal: { x: 50, y: 40 },
      overlay: 40,
      align: "full",
    })
  })

  it("a cover whose node has only one axis has no focal point", () => {
    expect(coverStoredAttrs({ focalX: 50, focalY: null })).toEqual({ decorative: true, overlay: 55 })
  })

  it("a cover back: only valid values reach the node", () => {
    expect(coverNodeAttrs({ overlay: 500, align: "huge", decorative: "yes", focal: { x: "1", y: 2 }, alt: "" })).toEqual({ decorative: true, overlay: 80 })
    expect(coverNodeAttrs({ overlay: 40, align: "wide", decorative: false, focal: { x: 10, y: 90 }, alt: "T" })).toEqual({
      alt: "T",
      decorative: false,
      focalX: 10,
      focalY: 90,
      overlay: 40,
      align: "wide",
    })
  })

  it("media & text: position only when not the default", () => {
    expect(mediaTextStoredAttrs({ decorative: false, position: "left" })).toEqual({ decorative: false })
    expect(mediaTextStoredAttrs({ decorative: true, position: "right", alt: "D" })).toEqual({ alt: "D", decorative: true, position: "right" })
    expect(mediaTextNodeAttrs({ position: "center" })).toEqual({ decorative: false })
    expect(mediaTextNodeAttrs({ position: "right", decorative: true })).toEqual({ decorative: true, position: "right" })
  })
})

describe("validateBlockDoc (Zod)", () => {
  const doc = (type: string, attrs: Record<string, unknown>) => ({
    doc_version: 1,
    blocks_order: ["block-0001"],
    blocks: {
      "block-0001": { id: "block-0001", type, version: 1, attrs, children: ["para-00001"] },
      "para-00001": { id: "para-00001", type: "paragraph", version: 1, attrs: { text: "x" } },
    },
  })

  it("takes what the bridge writes", () => {
    expect(() => validateBlockDoc(doc("cover", { mediaId: 1, alt: "A", decorative: false, focal: { x: 1, y: 2 }, overlay: 55, align: "full" }))).not.toThrow()
    expect(() => validateBlockDoc(doc("media_text", { mediaId: 1, decorative: false, position: "right" }))).not.toThrow()
  })

  it.each([
    ["an overlay over the top", { overlay: 85 }],
    ["an overlay off the step", { overlay: 57 }],
    ["a focal point out of range", { focal: { x: 101, y: 0 } }],
    ["a fractional focal point", { focal: { x: 1.5, y: 0 } }],
    ["a focal point with more keys", { focal: { x: 1, y: 0, z: 2 } }],
    ["an align outside the enum", { align: "huge" }],
    ["an empty alt", { alt: "" }],
    ["a non-positive media id", { mediaId: 0 }],
  ])("refuses %s", (_label, attrs) => {
    expect(() => validateBlockDoc(doc("cover", attrs))).toThrow()
  })

  it("refuses a position outside the enum", () => {
    expect(() => validateBlockDoc(doc("media_text", { position: "center" }))).toThrow()
  })
})
