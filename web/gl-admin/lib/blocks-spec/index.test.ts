import { describe, it, expect } from "vitest"
import {
  validateBlock,
  validateBlockDoc,
  zBlockID,
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

  // Documents a known quirk: because zBlock is a union with a permissive custom
  // catch-all (type: string, attrs: record), a KNOWN type that fails its strict
  // schema (e.g. heading missing `level`) still validates as a custom block
  // rather than throwing. This test pins that behavior so a future tightening of
  // the union is a conscious, visible change.
  it("accepts a malformed known type via the custom fallback (documented quirk)", () => {
    const headingNoLevel = { id: id(), type: "heading", version: 1, attrs: {} }
    expect(() => validateBlock(headingNoLevel)).not.toThrow()
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
})
