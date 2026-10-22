import { describe, it, expect } from "vitest"
import { ZodError } from "zod"
import {
  validateBlock,
  validateBlockDoc,
  zBlockID,
  zHeading,
  type BlockDocV1,
} from "./index"

// A valid BlockID is any string >= 10 chars (ULID/UUID). Use real UUID-ish ids.
const id = (suffix = "") => `00000000-0000-4000-8000-00000000000${suffix || "0"}`

describe("zBlockID", () => {
  it("accepts strings of length >= 10", () => {
    expect(zBlockID.safeParse("0123456789").success).toBe(true)
    expect(zBlockID.safeParse(id()).success).toBe(true)
  })

  it("rejects strings shorter than 10 chars", () => {
    expect(zBlockID.safeParse("short").success).toBe(false)
    expect(zBlockID.safeParse("").success).toBe(false)
  })
})

describe("validateBlock — known block types", () => {
  it("validates a paragraph block", () => {
    const block = { id: id(), type: "paragraph", version: 1, attrs: { text: "hi" } }
    expect(() => validateBlock(block)).not.toThrow()
  })

  it("validates a heading with a legal level", () => {
    const block = { id: id(), type: "heading", version: 1, attrs: { level: 2, text: "T" } }
    expect(validateBlock(block).type).toBe("heading")
  })

  it("validates h4-h6 against the strict heading schema (not the custom catch-all)", () => {
    const block = { id: id(), type: "heading", version: 1, attrs: { level: 5, text: "T" } }
    expect(zHeading.safeParse(block).success).toBe(true)
  })

  it("validates a code_block (code required)", () => {
    const block = { id: id(), type: "code_block", version: 1, attrs: { code: "x = 1" } }
    expect(() => validateBlock(block)).not.toThrow()
  })

  it("validates a divider with empty attrs", () => {
    expect(() => validateBlock({ id: id(), type: "divider", version: 1, attrs: {} })).not.toThrow()
  })

  it("validates an image block with optional attrs", () => {
    const block = { id: id(), type: "image", version: 1, attrs: { src: "/x.png", mediaId: 7 } }
    expect(() => validateBlock(block)).not.toThrow()
  })
})

describe("validateBlock — invalid payloads", () => {
  it("rejects a block with a too-short id", () => {
    expect(() => validateBlock({ id: "x", type: "paragraph", version: 1, attrs: {} })).toThrow()
  })

  it("rejects a block with the wrong version", () => {
    expect(() => validateBlock({ id: id(), type: "paragraph", version: 2, attrs: {} })).toThrow()
  })

  it("rejects a non-object", () => {
    expect(() => validateBlock(null)).toThrow()
    expect(() => validateBlock("nope")).toThrow()
  })
})

describe("validateBlock — custom/theme catch-all", () => {
  it("accepts an unknown theme block type via the custom schema", () => {
    const block = { id: id(), type: "alert", version: 1, attrs: { variant: "warn", pm: {} } }
    expect(validateBlock(block).type).toBe("alert")
  })

  // zBlock used to be a union whose custom catch-all also accepted a KNOWN type that
  // failed its own schema. The collab server validates at its store boundary (#206),
  // where that would let a broken heading through, so known types are strict now (#214).
  it("rejects a malformed known type instead of accepting it as custom", () => {
    expect(() => validateBlock({ id: id(), type: "heading", version: 1, attrs: {} })).toThrow()
    expect(() => validateBlock({ id: id(), type: "heading", version: 1, attrs: { level: 7 } })).toThrow()
    expect(() => validateBlock({ id: id(), type: "code_block", version: 1, attrs: {} })).toThrow()
  })

  it("accepts every heading level from 1 to 6 through validateBlock", () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(() => validateBlock({ id: id(), type: "heading", version: 1, attrs: { level } })).not.toThrow()
    }
  })

  it("does not treat inherited object keys as known types", () => {
    const block = { id: id(), type: "toString", version: 1, attrs: {} }
    expect(validateBlock(block).type).toBe("toString")
  })
})

describe("validateBlock — returns the input unchanged", () => {
  it("keeps list children and keys the schemas don't list", () => {
    const block = { id: id(), type: "bullet_list", version: 1, attrs: {}, children: [id("1")], extra: true }
    expect(validateBlock(block)).toBe(block)
    expect(validateBlock(block)).toEqual(block)
  })

  it("rejects list children that aren't block ids", () => {
    expect(() => validateBlock({ id: id(), type: "ordered_list", version: 1, attrs: {}, children: ["x"] })).toThrow()
  })
})

describe("validateBlockDoc", () => {
  it("validates a well-formed document", () => {
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [id("1"), id("2")],
      blocks: {
        [id("1")]: { id: id("1"), type: "paragraph", version: 1, attrs: { text: "a" } },
        [id("2")]: { id: id("2"), type: "heading", version: 1, attrs: { level: 1, text: "b" } },
      },
    }
    expect(() => validateBlockDoc(doc)).not.toThrow()
  })

  it("validates an empty document", () => {
    expect(() => validateBlockDoc({ doc_version: 1, blocks_order: [], blocks: {} })).not.toThrow()
  })

  it("rejects a wrong doc_version", () => {
    expect(() => validateBlockDoc({ doc_version: 2, blocks_order: [], blocks: {} })).toThrow()
  })

  it("rejects a document whose block map key is too short", () => {
    const bad = {
      doc_version: 1,
      blocks_order: ["short"],
      blocks: { short: { id: "short", type: "paragraph", version: 1, attrs: {} } },
    }
    expect(() => validateBlockDoc(bad)).toThrow()
  })

  it("rejects a block stored under another block's id", () => {
    const bad = {
      doc_version: 1,
      blocks_order: [id("1")],
      blocks: { [id("1")]: { id: id("2"), type: "paragraph", version: 1, attrs: {} } },
    }
    expect(() => validateBlockDoc(bad)).toThrow(/map key/)
  })

  it("rejects a document containing a malformed known block", () => {
    const bad = {
      doc_version: 1,
      blocks_order: [id("1")],
      blocks: { [id("1")]: { id: id("1"), type: "heading", version: 1, attrs: { level: 9 } } },
    }
    expect(() => validateBlockDoc(bad)).toThrow()
  })

  it("rejects a null block with a ZodError, not a TypeError", () => {
    const bad = { doc_version: 1, blocks_order: [], blocks: { [id("1")]: null } }
    expect(() => validateBlockDoc(bad)).toThrow(ZodError)
  })

  it("rejects a string mediaId (the API's media sync only reads numbers)", () => {
    expect(() => validateBlock({ id: id(), type: "image", version: 1, attrs: { mediaId: "42" } })).toThrow()
  })

  it("returns the same document object", () => {
    const doc = { doc_version: 1, blocks_order: [], blocks: {} }
    expect(validateBlockDoc(doc)).toBe(doc)
  })
})
