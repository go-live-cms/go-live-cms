// @vitest-environment node
// Plain Node, like the collab server (#206): no DOM, no editor.
import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import type { BlockDocV1 } from "../blocks-spec"
import { validateBlockDoc } from "../blocks-spec"
import { getCoreSchema } from "./schema"
import {
  EDITOR_FRAGMENT,
  fragmentToBlockDoc,
  seedFragment,
  stampFragmentBlockIds,
  type UnconvertibleBlock,
} from "./fragmentBridge"
import { canonical, ids, richDoc } from "./fragmentBridge.fixtures"

const base = getCoreSchema()

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
    expect(fragmentToBlockDoc(fragment, base, { dropped })).toEqual(doc)
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
    expect(fragmentToBlockDoc(fragment, base, { dropped })).toEqual(source)
  })

  it("restoring needs only the dropped trees, not the whole source doc", () => {
    const { ydoc, dropped } = seeded(docWithBadBlocks())
    // What the server keeps between loads: the Yjs state and the dropped blocks.
    const kept = JSON.parse(JSON.stringify(dropped))
    expect(fragmentToBlockDoc(reloaded(ydoc), base, { dropped: kept })).toEqual(docWithBadBlocks())
  })

  it("without the dropped record, a store would lose them (why the server must keep it)", () => {
    const { fragment } = seeded(docWithBadBlocks())
    const out = fragmentToBlockDoc(fragment, base)
    expect(out.blocks["blk-badcode-001"]).toBeUndefined()
  })
})

describe("a node the store can't convert (#206)", () => {
  // Stand-ins cover unknown node and mark types, but a malformed element from a buggy or
  // newer peer can still make Node.fromJSON throw. Here: the intro paragraph replaced by
  // an element named "text" with no text ("Invalid text node in JSON"), keeping its id.
  // That must cost one block, not the whole store.
  function withMalformedIntro() {
    const doc = canonical(richDoc())
    const { ydoc, fragment } = seeded(doc)
    ydoc.transact(() => {
      fragment.delete(0, 1)
      const malformed = new Y.XmlElement("text")
      fragment.insert(0, [malformed])
      malformed.setAttribute("data-block-id", ids.intro)
    })
    return { doc, fragment }
  }

  it("converts every other block and reports it", () => {
    const { doc, fragment } = withMalformedIntro()
    const reported: UnconvertibleBlock[] = []
    const out = fragmentToBlockDoc(fragment, base, { onUnconvertible: (block) => reported.push(block) })
    expect(reported.map(({ id, type }) => ({ id, type }))).toEqual([{ id: ids.intro, type: "text" }])
    expect(out.blocks_order).toEqual(doc.blocks_order.filter((id) => id !== ids.intro))
  })

  it("keeps the block's last stored version, in place, when given the previous doc", () => {
    const { doc, fragment } = withMalformedIntro()
    expect(fragmentToBlockDoc(fragment, base, { previous: doc })).toEqual(doc)
  })
})

describe("theme marks on the server (#206)", () => {
  it("stores text carrying a mark the core schema doesn't know", () => {
    const doc = canonical(richDoc())
    const { ydoc, fragment } = seeded(doc)
    const outro = (fragment.get(fragment.length - 1) as Y.XmlElement).get(0) as Y.XmlText
    ydoc.transact(() => outro.format(0, 3, { highlight: { color: "yellow" } }))
    const out = fragmentToBlockDoc(fragment, base)
    const marks = (out.blocks[ids.outro].attrs as any).pm.content[0].marks
    expect(marks).toEqual([{ type: "highlight", attrs: { color: "yellow" } }])
    // ...and it seeds back unchanged.
    expect(fragmentToBlockDoc(seeded(out).fragment, base)).toEqual(out)
  })
})

describe("stampFragmentBlockIds (#206)", () => {
  let counter = 0
  const newId = () => `blk-stamped-${String(++counter).padStart(4, "0")}`

  function unstampedDoc() {
    const ydoc = new Y.Doc()
    const fragment = ydoc.getXmlFragment(EDITOR_FRAGMENT)
    const paragraph = (id?: string) => {
      const el = new Y.XmlElement("paragraph")
      if (id) el.setAttribute("data-block-id", id)
      return el
    }
    const item = (id?: string) => {
      const el = new Y.XmlElement("listItem")
      if (id) el.setAttribute("data-block-id", id)
      el.insert(0, [paragraph()])
      return el
    }
    ydoc.transact(() => {
      const list = new Y.XmlElement("bulletList")
      list.setAttribute("data-block-id", "blk-list-000001")
      fragment.insert(0, [paragraph("blk-first-00001"), paragraph(), paragraph("blk-first-00001"), paragraph("short"), list])
      const nested = new Y.XmlElement("bulletList")
      const outer = item("blk-item-000001")
      list.insert(0, [outer, item()])
      outer.insert(1, [nested])
      nested.insert(0, [item("blk-item-000001")])
    })
    return { ydoc, fragment }
  }

  it("stamps missing, short and duplicate ids (top level and list items at any depth), keeping the first", () => {
    const { fragment } = unstampedDoc()
    expect(stampFragmentBlockIds(fragment, newId)).toBe(5)
    const top = fragment.toArray() as Y.XmlElement[]
    const topIds = top.map((el) => el.getAttribute("data-block-id"))
    expect(topIds[0]).toBe("blk-first-00001")
    expect(new Set(topIds).size).toBe(topIds.length)
    const [outer, second] = top[4].toArray() as Y.XmlElement[]
    expect(outer.getAttribute("data-block-id")).toBe("blk-item-000001")
    expect(second.getAttribute("data-block-id")).toMatch(/^blk-stamped-/)
    const nestedItem = ((outer.get(1) as Y.XmlElement).get(0) as Y.XmlElement).getAttribute("data-block-id")
    expect(nestedItem).toMatch(/^blk-stamped-/)
    // Paragraphs inside list items are not blocks: never stamped.
    expect((outer.get(0) as Y.XmlElement).getAttribute("data-block-id")).toBeUndefined()
  })

  it("makes stores stable: two stores give the same ids", () => {
    const { fragment } = unstampedDoc()
    stampFragmentBlockIds(fragment, newId)
    expect(fragmentToBlockDoc(fragment, base)).toEqual(fragmentToBlockDoc(fragment, base))
  })

  it("writes nothing when every id is already fine", () => {
    const { ydoc, fragment } = seeded(richDoc())
    let updates = 0
    ydoc.on("update", () => updates++)
    expect(stampFragmentBlockIds(fragment, newId)).toBe(0)
    expect(updates).toBe(0)
  })

  it("stamps everything in one transaction", () => {
    const { ydoc, fragment } = unstampedDoc()
    let updates = 0
    ydoc.on("update", () => updates++)
    stampFragmentBlockIds(fragment, newId)
    expect(updates).toBe(1)
  })
})
