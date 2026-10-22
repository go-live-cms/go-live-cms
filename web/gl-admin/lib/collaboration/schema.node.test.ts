// @vitest-environment node
import { describe, it, expect } from "vitest"
import type { BlockDocV1 } from "../blocks-spec"
import { blockDocToPMWithReport } from "./blockBridge"
import { getCollabSchema, getCoreSchema, schemaWithStandIns } from "./schema"
import { AlertSchema } from "../../../themes/example/blocks/Alert/AlertSchema"

// The collab server (#206) runs in plain Node, with no DOM. Every other collaboration
// test runs under jsdom (vitest.config.ts), which would hide an extension that touches
// `window`/`document` while its schema is built.
describe("core schema without a DOM (#206)", () => {
  it("builds in plain Node", () => {
    expect(typeof globalThis.document).toBe("undefined")
    const schema = getCoreSchema()
    expect(schema.nodes.heading).toBeDefined()
    expect(schema.marks.link).toBeDefined()
  })
})

describe("headless theme definitions on the server (#206)", () => {
  const alertDoc = (content: unknown[]): BlockDocV1 => ({
    doc_version: 1,
    blocks_order: ["blk-alert-000001"],
    blocks: {
      "blk-alert-000001": {
        id: "blk-alert-000001",
        type: "alert",
        version: 1,
        attrs: { pm: { type: "alert", attrs: { variant: "warn", "data-block-id": "blk-alert-000001" }, content } },
      },
    },
  })

  it("a theme's headless schema loads without React or a DOM", () => {
    const schema = getCollabSchema([AlertSchema])
    expect(schema.nodes.alert.spec.content).toBe("text*")
    expect(getCollabSchema([AlertSchema])).toBe(schema)
  })

  it("with the real definition, a malformed theme block is checked and dropped (a stand-in would pass it)", () => {
    // An alert holds text only; this one holds a paragraph.
    const bad = alertDoc([{ type: "paragraph", content: [{ type: "text", text: "x" }] }])
    expect(blockDocToPMWithReport(bad, getCollabSchema([AlertSchema])).dropped.map((d) => d.id)).toEqual(["blk-alert-000001"])
    const standIn = schemaWithStandIns(getCoreSchema(), [(bad.blocks["blk-alert-000001"].attrs as { pm: unknown }).pm])
    expect(blockDocToPMWithReport(bad, standIn).dropped).toEqual([])
  })

  it("a well-formed theme block passes its real definition", () => {
    const good = alertDoc([{ type: "text", text: "Careful" }])
    expect(blockDocToPMWithReport(good, getCollabSchema([AlertSchema])).dropped).toEqual([])
  })
})
