import { describe, expect, it } from "vitest"
import vectors from "./inlineNodeVectors.json"
import {
  addDays,
} from "../mentionMenu"
import {
  chipDateInstant,
  contentLinkAttrs,
  dateChipAttrs,
  formatChipTime,
  INLINE_LABEL_MAX_LENGTH,
  mentionAttrs,
  normalizeEntityId,
  normalizeInlineLabel,
} from "./inlineNodes"

// #320: the inline nodes' stored values. The vectors are shared with the API's sanitizer
// (api/inline_nodes_test.go TestInlineNodeVectors), so both keep and drop the same things.

const normalizers: Record<string, (attrs: Record<string, unknown>) => unknown> = {
  mention: mentionAttrs,
  contentLink: contentLinkAttrs,
  dateChip: dateChipAttrs,
}

describe("inline node vectors (shared with the API)", () => {
  it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(normalizers[c.type](c.attrs as Record<string, unknown>)).toEqual(c.expected)
  })
})

describe("normalizers", () => {
  it("caps a label at INLINE_LABEL_MAX_LENGTH code points", () => {
    expect(normalizeInlineLabel("á".repeat(250))).toBe("á".repeat(INLINE_LABEL_MAX_LENGTH))
    // Astral characters count once, as in Go.
    expect(Array.from(normalizeInlineLabel("😀".repeat(250))!)).toHaveLength(INLINE_LABEL_MAX_LENGTH)
    expect(normalizeInlineLabel(7)).toBeNull()
  })

  it("reads ids from JSON numbers and HTML digits only", () => {
    expect(normalizeEntityId(5)).toBe(5)
    expect(normalizeEntityId(" 12 ")).toBe(12)
    expect(normalizeEntityId("1e3")).toBeNull()
    expect(normalizeEntityId(null)).toBeNull()
  })

  it("formats a chip's day the same everywhere (noon UTC) and its time in the language", () => {
    expect(chipDateInstant("2026-11-12").toISOString()).toBe("2026-11-12T12:00:00.000Z")
    expect(formatChipTime("14:30", "en-US")).toBe("2:30 PM")
    expect(formatChipTime("14:30", "pt-BR")).toBe("14:30")
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
  })
})
