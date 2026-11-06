import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import type { BlockDocV1 } from "../gl-admin/lib/blocks-spec"
import { EDITOR_FRAGMENT, stampFragmentBlockIds } from "../gl-admin/lib/collaboration/fragmentBridge"
import { BlockChangeTracker, blockEditsFor, type BlockTouch } from "./blockEdits"
import { SERVER_ORIGIN } from "./load"

// The block change tracker (#328) on a plain Y.Doc, with origins shaped like Hocuspocus's
// (a Connection carries its authenticated `context`). The relay tests
// (gl-admin/lib/collaboration/blockEdits.hocuspocus.test.ts) run it on the real server.

const as = (userId: string) => ({ context: { userId } })

function paragraph(id: string | null, text: string): Y.XmlElement {
  const p = new Y.XmlElement("paragraph")
  if (id) p.setAttribute("data-block-id", id)
  p.insert(0, [new Y.XmlText(text)])
  return p
}

function setup() {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment(EDITOR_FRAGMENT)
  doc.transact(() => {
    fragment.insert(0, [paragraph("blk-alpha-000001", "alpha"), paragraph("blk-beta-0000001", "beta")])
  }, SERVER_ORIGIN)
  let now = 1_000
  const tracker = new BlockChangeTracker(fragment, () => now)
  return { doc, fragment, tracker, tick: (ms: number) => (now += ms) }
}

const touchedIds = (tracker: BlockChangeTracker) =>
  Object.fromEntries([...tracker.capture().byId.entries()].map(([id, t]) => [id, t.userId]))

describe("BlockChangeTracker", () => {
  it("records an edit of an existing block (tr.changed) for the connection's user", () => {
    const { doc, fragment, tracker } = setup()
    const alpha = fragment.get(0) as Y.XmlElement
    doc.transact(() => (alpha.get(0) as Y.XmlText).insert(5, " one"), as("7"))
    expect(touchedIds(tracker)).toEqual({ "blk-alpha-000001": "7" })
  })

  it("records a new block (its parent's changes.added), and every block inside a new container", () => {
    const { doc, fragment, tracker } = setup()
    doc.transact(() => fragment.insert(2, [paragraph(null, "new")]), as("3"))
    const group = new Y.XmlElement("group")
    group.setAttribute("data-block-id", "blk-group-000001")
    group.insert(0, [paragraph("blk-inner-000001", "inner"), paragraph("blk-inner-000002", "inner two")])
    doc.transact(() => fragment.insert(0, [group]), as("4"))

    // The new paragraph has no id until the store stamps one (keyed by element, not id).
    const stamped = stampFragmentBlockIds(fragment, () => "blk-stamped-0001")
    expect(stamped).toBe(1)
    expect(touchedIds(tracker)).toEqual({
      "blk-stamped-0001": "3",
      "blk-group-000001": "4",
      "blk-inner-000001": "4",
      "blk-inner-000002": "4",
    })
  })

  it("attributes the nearest block at any depth: a list item, an image's caption, a block in a group", () => {
    const { doc, fragment, tracker } = setup()
    const list = new Y.XmlElement("bulletList")
    list.setAttribute("data-block-id", "blk-list-0000001")
    const item = new Y.XmlElement("listItem")
    item.setAttribute("data-block-id", "blk-item-0000001")
    item.insert(0, [paragraph(null, "item")])
    list.insert(0, [item])
    const group = new Y.XmlElement("group")
    group.setAttribute("data-block-id", "blk-group-000001")
    group.insert(0, [paragraph("blk-inner-000001", "inner")])
    doc.transact(() => fragment.insert(2, [list, group]), SERVER_ORIGIN)
    expect(tracker.size).toBe(0)

    const itemText = (item.get(0) as Y.XmlElement).get(0) as Y.XmlText
    doc.transact(() => itemText.insert(4, "!"), as("5"))
    const innerText = (group.get(0) as Y.XmlElement).get(0) as Y.XmlText
    doc.transact(() => innerText.insert(0, ">"), as("6"))
    expect(touchedIds(tracker)).toEqual({ "blk-item-0000001": "5", "blk-inner-000001": "6" })
  })

  it("ignores the server's own writes and origins without a user", () => {
    const { doc, fragment, tracker } = setup()
    const alpha = fragment.get(0) as Y.XmlElement
    doc.transact(() => alpha.setAttribute("data-block-id", "blk-restamped-01"), SERVER_ORIGIN)
    doc.transact(() => (alpha.get(0) as Y.XmlText).insert(0, "x"), { context: {} })
    doc.transact(() => (alpha.get(0) as Y.XmlText).insert(0, "y"), null)
    expect(tracker.size).toBe(0)
  })

  it("clears only what a store was prepared with: a later edit of the same block stays", () => {
    const { doc, fragment, tracker, tick } = setup()
    const alpha = fragment.get(0) as Y.XmlElement
    const beta = fragment.get(1) as Y.XmlElement
    doc.transact(() => (alpha.get(0) as Y.XmlText).insert(0, "a"), as("1"))
    doc.transact(() => (beta.get(0) as Y.XmlText).insert(0, "b"), as("1"))
    const capture = tracker.capture()
    tick(500)
    // While the PUT is in flight, user 2 edits alpha again.
    doc.transact(() => (alpha.get(0) as Y.XmlText).insert(0, "c"), as("2"))
    tracker.clear(capture)
    const left = tracker.capture().byId
    expect([...left.keys()]).toEqual(["blk-alpha-000001"])
    expect(left.get("blk-alpha-000001")).toEqual({ userId: "2", at: 1_500 })
  })

  it("stops observing when destroyed", () => {
    const { doc, fragment, tracker } = setup()
    tracker.destroy()
    doc.transact(() => ((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, "x"), as("1"))
    expect(tracker.size).toBe(0)
  })
})

describe("blockEditsFor", () => {
  const doc = (blocks: Record<string, unknown>): BlockDocV1 =>
    ({ doc_version: 1, blocks_order: Object.keys(blocks), blocks }) as unknown as BlockDocV1
  const capture = (byId: Record<string, BlockTouch>, fragmentIds: string[]) => ({
    entries: new Map(),
    byId: new Map(Object.entries(byId)),
    fragmentIds: new Set(fragmentIds),
  })
  const p = (text: string) => ({ type: "paragraph", version: 1, attrs: { text } })

  it("attributes only new or changed blocks, from the tracker, else the fallback", () => {
    const previous = doc({ a: p("a"), b: p("b"), c: p("c") })
    const next = doc({ a: p("a!"), b: p("b"), c: p("c?"), d: p("d") })
    const edits = blockEditsFor(next, previous, capture({ a: { userId: "1", at: 0 } }, ["a", "b", "c", "d"]), { userId: "9", at: 60_000 })
    expect(edits).toEqual([
      { block_id: "a", user_id: 1, edited_at: "1970-01-01T00:00:00.000Z" },
      { block_id: "c", user_id: 9, edited_at: "1970-01-01T00:01:00.000Z" },
      { block_id: "d", user_id: 9, edited_at: "1970-01-01T00:01:00.000Z" },
    ])
  })

  it("compares canonically (jsonb reorders keys), and leaves out blocks not from the fragment", () => {
    const previous = doc({ a: { attrs: { text: "a" }, version: 1, type: "paragraph" } })
    // `hidden` was copied in from meta.dropped or the unconvertible fallback: nobody edited it.
    const next = doc({ a: p("a"), hidden: p("kept") })
    expect(blockEditsFor(next, previous, capture({}, ["a"]), { userId: "1", at: 0 })).toEqual([])
  })

  it("without a tracker entry or a fallback (no client edited), attributes nothing; bad user ids are skipped", () => {
    const next = doc({ a: p("a"), b: p("b") })
    expect(blockEditsFor(next, null, capture({}, ["a", "b"]), null)).toEqual([])
    expect(blockEditsFor(next, null, capture({ a: { userId: "x", at: 0 }, b: { userId: "0", at: 0 } }, ["a", "b"]), null)).toEqual([])
  })
})
