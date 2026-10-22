// @vitest-environment node
// Plain Node, like the collab server (#206): no DOM, no editor.
import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import type { BlockDocV1 } from "../blocks-spec"
import { validateBlockDoc } from "../blocks-spec"
import { blockDocToPM, pmToBlockDoc } from "./blockBridge"
import { getCoreSchema, schemaWithStandIns } from "./schema"
import { EDITOR_FRAGMENT, fragmentToBlockDoc, seedFragment } from "./fragmentBridge"
import { ids, richDoc } from "./fragmentBridge.fixtures"

const base = getCoreSchema()

/** What the editor would save for `doc`: one load + save through the bridge. */
function canonical(doc: BlockDocV1): BlockDocV1 {
  const roots = Object.values(doc.blocks).map((block) => (block.attrs as any)?.pm).filter(Boolean)
  return pmToBlockDoc(blockDocToPM(doc, schemaWithStandIns(base, roots)))
}

function seeded(doc: BlockDocV1) {
  const ydoc = new Y.Doc()
  const fragment = ydoc.getXmlFragment(EDITOR_FRAGMENT)
  const dropped = seedFragment(doc, fragment, base)
  return { ydoc, fragment, dropped }
}

/** A fresh doc holding only `ydoc`'s state, as the server has after a restart. */
function reloaded(ydoc: Y.Doc) {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(ydoc))
  return copy.getXmlFragment(EDITOR_FRAGMENT)
}

describe("seed → store round trip (#206)", () => {
  it("stores exactly what the editor would save, for every block kind", () => {
    const doc = canonical(richDoc())
    const { fragment, dropped } = seeded(doc)
    expect(dropped.entries).toEqual([])
    expect(fragmentToBlockDoc(fragment, base, dropped)).toEqual(doc)
  })

  it("keeps every block id, list item ids included", () => {
    const { fragment } = seeded(richDoc())
    const out = fragmentToBlockDoc(fragment, base)
    expect(out.blocks_order).toEqual(richDoc().blocks_order)
    for (const id of [ids.item1, ids.item2, ids.item4]) expect(out.blocks[id]?.type).toBe("list_item")
    expect(out.blocks[ids.bullets].children).toEqual([ids.item1, ids.item2])
    // The nested list lives inside item2's PM JSON, with its own ids.
    expect(JSON.stringify(out.blocks[ids.item2].attrs)).toContain(ids.nestedItem)
  })

  it("is stable: storing, reseeding and storing again changes nothing", () => {
    const first = fragmentToBlockDoc(seeded(richDoc()).fragment, base)
    const second = fragmentToBlockDoc(seeded(first).fragment, base)
    expect(second).toEqual(first)
  })

  it("survives a server restart: the persisted Yjs state stores the same doc", () => {
    const { ydoc } = seeded(richDoc())
    expect(fragmentToBlockDoc(reloaded(ydoc), base)).toEqual(fragmentToBlockDoc(ydoc.getXmlFragment(EDITOR_FRAGMENT), base))
  })

  it("stores a doc that passes validateBlockDoc", () => {
    const out = fragmentToBlockDoc(seeded(richDoc()).fragment, base)
    expect(validateBlockDoc(out)).toBe(out)
  })

  it("keeps heading levels 4 to 6", () => {
    const out = fragmentToBlockDoc(seeded(richDoc()).fragment, base)
    expect((out.blocks[ids.h4].attrs as any).level).toBe(4)
    expect((out.blocks[ids.h6].attrs as any).level).toBe(6)
  })

  it("keeps marks, link attributes included", () => {
    const out = fragmentToBlockDoc(seeded(richDoc()).fragment, base)
    const marks = (out.blocks[ids.intro].attrs as any).pm.content.flatMap((t: any) => t.marks ?? [])
    expect(marks.map((m: any) => m.type)).toEqual(["bold", "link"])
    expect(marks[1].attrs.href).toBe("https://example.test")
  })

  it("an empty doc seeds nothing and stores an empty doc", () => {
    const empty: BlockDocV1 = { doc_version: 1, blocks_order: [], blocks: {} }
    const { fragment } = seeded(empty)
    expect(fragment.length).toBe(0)
    expect(fragmentToBlockDoc(fragment, base)).toEqual(empty)
  })

  it("refuses to seed a fragment that already has content (it would duplicate it)", () => {
    const { fragment } = seeded(richDoc())
    expect(() => seedFragment(richDoc(), fragment, base)).toThrow(/not empty/)
  })
})

describe("theme blocks on the server (#206)", () => {
  // The server has no theme extensions. Without stand-ins, blockDocToPMWithReport
  // would drop every theme block and the editors would never see them.
  it("seeds a theme block into the fragment with its attributes", () => {
    const { fragment, dropped } = seeded(richDoc())
    expect(dropped.entries.map((d) => d.id)).not.toContain(ids.callout)
    const element = fragment.toArray().find((n) => n instanceof Y.XmlElement && n.nodeName === "callout") as Y.XmlElement
    expect(element).toBeDefined()
    expect(element.getAttribute("variant")).toBe("warn")
    expect(element.getAttribute("data-block-id")).toBe(ids.callout)
  })

  it("stores the theme block back unchanged", () => {
    const doc = canonical(richDoc())
    const out = fragmentToBlockDoc(seeded(doc).fragment, base)
    expect(out.blocks[ids.callout]).toEqual(doc.blocks[ids.callout])
    expect(out.blocks[ids.callout].attrs).toMatchObject({ variant: "warn", text: "Theme block" })
  })

  it("stores a theme block that only exists in the live doc (added in the editor)", () => {
    const { ydoc, fragment } = seeded(canonical(richDoc()))
    const added = new Y.XmlElement("alert")
    ydoc.transact(() => {
      fragment.insert(fragment.length, [added])
      added.setAttribute("data-block-id", "blk-alert-00001")
      added.setAttribute("variant", "danger")
      added.insert(0, [new Y.XmlText("Live")])
    })
    const out = fragmentToBlockDoc(fragment, base)
    expect(out.blocks_order.at(-1)).toBe("blk-alert-00001")
    expect(out.blocks["blk-alert-00001"]).toMatchObject({ type: "alert", attrs: { variant: "danger", text: "Live" } })
  })
})

describe("blocks the editor can't show (#213) on the server", () => {
  // An empty code block can't be a ProseMirror node, and a divider can't be a list
  // item. Seeding leaves them out of the live doc; every store must put them back.
  function docWithBadBlocks(): BlockDocV1 {
    const doc = canonical(richDoc())
    const badCode = "blk-badcode-001"
    const badChild = "blk-badchild-01"
    return {
      ...doc,
      blocks_order: [ids.intro, badCode, ...doc.blocks_order.slice(1)],
      blocks: {
        ...doc.blocks,
        [badCode]: { id: badCode, type: "code_block", version: 1, attrs: { code: "" } },
        [badChild]: { id: badChild, type: "divider", version: 1, attrs: {} },
        [ids.bullets]: { ...doc.blocks[ids.bullets], children: [ids.item1, badChild, ids.item2] },
      },
    }
  }

  it("reports them with their content, and keeps them out of the live doc", () => {
    const { fragment, dropped } = seeded(docWithBadBlocks())
    expect(dropped.entries).toEqual([
      { id: "blk-badcode-001", parentId: null, afterId: ids.intro },
      { id: "blk-badchild-01", parentId: ids.bullets, afterId: ids.item1 },
    ])
    expect(Object.keys(dropped.blocks).sort()).toEqual(["blk-badchild-01", "blk-badcode-001"])
    expect(JSON.stringify(fragment.toJSON())).not.toContain("blk-badcode-001")
  })

  it("every store puts them back where they were", () => {
    const source = docWithBadBlocks()
    const { fragment, dropped } = seeded(source)
    expect(fragmentToBlockDoc(fragment, base, dropped)).toEqual(source)
  })

  it("restoring needs only the dropped trees, not the whole source doc", () => {
    const { ydoc, dropped } = seeded(docWithBadBlocks())
    // What the server keeps between loads: the Yjs state and the dropped blocks.
    const kept = JSON.parse(JSON.stringify(dropped))
    expect(fragmentToBlockDoc(reloaded(ydoc), base, kept)).toEqual(docWithBadBlocks())
  })

  it("without the dropped record, a store would lose them (why the server must keep it)", () => {
    const { fragment } = seeded(docWithBadBlocks())
    const out = fragmentToBlockDoc(fragment, base)
    expect(out.blocks["blk-badcode-001"]).toBeUndefined()
  })
})
