// @vitest-environment node
// Plain Node, like the collab server: no DOM, no editor.
import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import { validateBlockDoc, type BlockDocV1 } from "../blocks-spec"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import { EDITOR_FRAGMENT, fragmentToBlockDoc, seedFragment, seedPlan } from "./fragmentBridge"
import vectors from "./importedDocs.vectors.json"

// The importer's output (#150). An imported post gets a block_doc and no Yjs state, so the
// collab server seeds the live doc from it on first open (rule 11): the same load path as a
// new post created with a body. These docs are what the Go converter makes from the
// real-world fixtures (api/import_convert_test.go writes them; importer/testdata has the
// exports). Every block must be one the editor builds: a block the bridge drops would be
// hidden from the editor (#213) right after the import.

const base = getInstalledCollabSchema()
const docs = Object.entries(vectors as unknown as Record<string, BlockDocV1>)

function blockSummary(doc: BlockDocV1) {
  return Object.fromEntries(
    Object.values(doc.blocks).map((block) => {
      const attrs = block.attrs as { text?: unknown; mediaId?: unknown }
      return [block.id, { type: block.type, text: attrs.text ?? null, mediaId: attrs.mediaId ?? null }]
    }),
  )
}

describe("imported docs seed without losing a block (#150)", () => {
  it("has the converter's vectors", () => {
    expect(docs.map(([name]) => name).sort()).toEqual(["blocks", "classic", "markdown"])
  })

  for (const [name, doc] of docs) {
    describe(name, () => {
      it("is a valid Block Spec v1 doc", () => {
        expect(() => validateBlockDoc(doc)).not.toThrow()
      })

      it("builds every block with the editor's schema", () => {
        const { node, dropped } = seedPlan(doc, base)
        expect(dropped.entries).toEqual([])
        expect(() => node.check()).not.toThrow()
      })

      it("stores back the same blocks after seeding", () => {
        const ydoc = new Y.Doc()
        const fragment = ydoc.getXmlFragment(EDITOR_FRAGMENT)
        const dropped = seedFragment(doc, fragment, base)
        expect(dropped.entries).toEqual([])
        const stored = fragmentToBlockDoc(fragment, base, { dropped })
        expect(() => validateBlockDoc(stored)).not.toThrow()
        expect(stored.blocks_order).toEqual(doc.blocks_order)
        expect(blockSummary(stored)).toEqual(blockSummary(doc))
      })
    })
  }
})
