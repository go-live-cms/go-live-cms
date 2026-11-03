// @vitest-environment node
import { describe, it, expect } from "vitest"
import type { BlockDocV1 } from "../blocks-spec"
import { blockDocToPMWithReport } from "./blockBridge"
import { getCollabSchema, getCoreSchema, schemaWithStandIns } from "./schema"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import alert from "../../../themes/example/blocks/Alert/index"

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

describe("headless theme definitions on the server (#206, #376)", () => {
  const ALERT = "blk-alert-000001"
  const alertDoc = (content: unknown[]): BlockDocV1 => ({
    doc_version: 1,
    blocks_order: [ALERT],
    blocks: {
      [ALERT]: { id: ALERT, type: alert.type, version: 1, attrs: { variant: "warning", pm: { type: alert.type, content } } },
    },
  })

  it("a theme block's definition (index.ts) loads without React or a DOM", () => {
    expect(typeof globalThis.document).toBe("undefined")
    const schema = getCollabSchema([alert.node])
    expect(schema.nodes[alert.type].spec.content).toBe("inline*")
    expect(getCollabSchema([alert.node])).toBe(schema)
    expect(getInstalledCollabSchema().nodes[alert.type]).toBeDefined()
  })

  it("with the real definition, a malformed theme block is checked and dropped (a stand-in would pass it)", () => {
    // An alert holds inline content; this one holds a paragraph.
    const bad = alertDoc([{ type: "paragraph", content: [{ type: "text", text: "x" }] }])
    expect(blockDocToPMWithReport(bad, getInstalledCollabSchema()).dropped.map((d) => d.id)).toEqual([ALERT])
  })

  it("a well-formed theme block passes its real definition, with its attrs from the block", () => {
    const good = alertDoc([{ type: "text", text: "Careful" }])
    const { node, dropped } = blockDocToPMWithReport(good, getInstalledCollabSchema())
    expect(dropped).toEqual([])
    expect(node.firstChild!.attrs).toMatchObject({ variant: "warning", "data-block-id": ALERT })
  })

  it("without its theme installed, the block is dropped (hidden and kept), even with a stand-in for the type", () => {
    const good = alertDoc([{ type: "text", text: "Careful" }])
    const standIn = schemaWithStandIns(getCoreSchema(), [(good.blocks[ALERT].attrs as { pm: unknown }).pm])
    expect(blockDocToPMWithReport(good, standIn).dropped.map((d) => d.id)).toEqual([ALERT])
  })
})
