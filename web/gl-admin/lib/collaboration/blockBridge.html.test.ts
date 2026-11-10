import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import { isSnippetId, normalizeSnippetId, validateBlockDoc, type BlockDocV1 } from "../blocks-spec"
import { blockDocToPMWithReport, pmToBlockDoc } from "./blockBridge"
import { fragmentToBlockDoc, seedFragment } from "./fragmentBridge"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"

// Custom HTML (#428) through the chain the editor and the collab server use. The block holds
// a snippet id and nothing else: no client can get markup into a working copy through it,
// and a version's markup doesn't come back into the editor.

const schema = getInstalledCollabSchema()

const BLOCK = "blk-0428-html-0000001"
const AFTER = "blk-0428-after-000001"
const SNIPPET = "11111111-1111-4111-8111-111111111111"

function htmlDoc(attrs: Record<string, unknown>): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [BLOCK, AFTER],
    blocks: {
      [BLOCK]: { id: BLOCK, type: "html", version: 1, attrs } as BlockDocV1["blocks"][string],
      [AFTER]: { id: AFTER, type: "paragraph", version: 1, attrs: { text: "after", pm: { type: "paragraph", attrs: { "data-block-id": AFTER }, content: [{ type: "text", text: "after" }] } } },
    },
  }
}

describe("snippet ids", () => {
  it("are the API's UUIDs and nothing else", () => {
    expect(isSnippetId(SNIPPET)).toBe(true)
    for (const bad of ["", "x", "AAAAAAAA-1111-4111-8111-111111111111", `${SNIPPET} `, `../${SNIPPET}`, 12, null, undefined, {}]) {
      expect(isSnippetId(bad)).toBe(false)
      expect(normalizeSnippetId(bad)).toBeNull()
    }
  })
})

describe("the bridge (#428)", () => {
  it("round-trips the snippet id", () => {
    const { node: pm } = blockDocToPMWithReport(htmlDoc({ snippetId: SNIPPET }), schema)
    expect(pm.child(0).type.name).toBe("html")
    expect(pm.child(0).attrs).toMatchObject({ "data-block-id": BLOCK, snippetId: SNIPPET })
    const back = pmToBlockDoc(pm)
    expect(back.blocks[BLOCK]).toEqual({ id: BLOCK, type: "html", version: 1, attrs: { snippetId: SNIPPET } })
    expect(() => validateBlockDoc(back)).not.toThrow()
  })

  it("keeps a block with no snippet yet", () => {
    const { node: pm, dropped } = blockDocToPMWithReport(htmlDoc({}), schema)
    expect(dropped).toEqual([])
    expect(pmToBlockDoc(pm).blocks[BLOCK]).toEqual({ id: BLOCK, type: "html", version: 1, attrs: {} })
  })

  it("never brings a version's markup into the editor (a restore brings the id back)", () => {
    const { node: pm } = blockDocToPMWithReport(htmlDoc({ snippetId: SNIPPET, html: "<p>as published</p>" }), schema)
    expect(pm.child(0).attrs).not.toHaveProperty("html")
    expect(JSON.stringify(pm.toJSON())).not.toContain("as published")
    expect(pmToBlockDoc(pm).blocks[BLOCK].attrs).toEqual({ snippetId: SNIPPET })
  })

  it("drops a bad id on the way in and on the way out", () => {
    const { node: pm } = blockDocToPMWithReport(htmlDoc({ snippetId: "not-a-snippet" }), schema)
    expect(pm.child(0).attrs.snippetId).toBeNull()
  })

  it("nests in a group, and a group's flow accepts it", () => {
    expect(schema.nodes.group.contentMatch.matchType(schema.nodes.html)).toBeTruthy()
    expect(schema.nodes.blockquote.contentMatch.matchType(schema.nodes.html)).toBeFalsy()
  })
})

describe("the store (a Yjs fragment, as any client can write it)", () => {
  it("keeps only the id, whatever else the element carries", () => {
    const ydoc = new Y.Doc()
    const fragment = ydoc.getXmlFragment("default")
    seedFragment(htmlDoc({ snippetId: SNIPPET }), fragment, schema)
    const element = fragment.get(0) as Y.XmlElement
    expect(element.nodeName).toBe("html")

    // What a modified client can do to the shared doc.
    ydoc.transact(() => {
      element.setAttribute("html", "<img src=x onerror=alert(1)>")
      element.setAttribute("onclick", "alert(1)")
    })
    const out = fragmentToBlockDoc(fragment, schema)
    expect(out.blocks[BLOCK]).toEqual({ id: BLOCK, type: "html", version: 1, attrs: { snippetId: SNIPPET } })
    expect(JSON.stringify(out)).not.toContain("onerror")
    expect(() => validateBlockDoc(out)).not.toThrow()
  })

  it("drops an id that isn't one", () => {
    const ydoc = new Y.Doc()
    const fragment = ydoc.getXmlFragment("default")
    seedFragment(htmlDoc({ snippetId: SNIPPET }), fragment, schema)
    ydoc.transact(() => (fragment.get(0) as Y.XmlElement).setAttribute("snippetId", "../../etc/passwd"))
    expect(fragmentToBlockDoc(fragment, schema).blocks[BLOCK].attrs).toEqual({})
  })
})

describe("validateBlockDoc", () => {
  it("accepts an id or none, and refuses markup in a working copy", () => {
    expect(() => validateBlockDoc(htmlDoc({ snippetId: SNIPPET }))).not.toThrow()
    expect(() => validateBlockDoc(htmlDoc({}))).not.toThrow()
    expect(() => validateBlockDoc(htmlDoc({ snippetId: "nope" }))).toThrow()
    expect(() => validateBlockDoc(htmlDoc({ snippetId: SNIPPET, html: "<b>x</b>" }))).toThrow()
  })
})
