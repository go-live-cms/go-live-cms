import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import type * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration, { isChangeOrigin } from "@tiptap/extension-collaboration"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, POST_ID, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { paragraphDoc } from "../../../../collab-server/testkit"
import {
  BlockActions,
  duplicateBlock,
  moveBlockUnder,
  refOf,
  setBlockColor,
  topLevelBlockAt,
  type TopLevelBlock,
} from "./blockActions"

// The block menu's actions with two people on the same post (#356), on the real
// Hocuspocus server (hocuspocusRelay.testkit.ts): each action reaches the other editor as
// one Yjs transaction, block ids stay unique (top-level blocks and list items, in both
// editors and in the stored block_doc), and the editors go quiet afterwards (no id
// re-stamping bouncing between them, rule 7).

const editors: Editor[] = []
let relay: Relay

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  relay = await startRelay({ blockDoc: canonical(paragraphDoc("start")), revision: 2 })
})

afterEach(async () => {
  while (editors.length) editors.pop()!.destroy()
  await relay.destroy()
  vi.restoreAllMocks()
})

function makePeer(doc: Y.Doc): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: true })),
      BlockActions,
      Collaboration.configure({ document: doc }),
    ],
  })
  editors.push(editor)
  return editor
}

const CONTENT = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "First" }] },
    { type: "paragraph", content: [{ type: "text", text: "alpha" }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Second" }] },
    { type: "paragraph", content: [{ type: "text", text: "beta" }] },
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "two" }] },
            {
              type: "bulletList",
              content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "nested" }] }] }],
            },
          ],
        },
      ],
    },
    // Ends in a paragraph: after a final list TipTap's TrailingNode would append one.
    { type: "paragraph", content: [{ type: "text", text: "end" }] },
  ],
}

async function twoEditors() {
  const pa = relay.client("1")
  const pb = relay.client("2")
  await Promise.all([pa.whenSynced(), pb.whenSynced()])
  const a = makePeer(pa.doc)
  const b = makePeer(pb.doc)
  a.commands.setContent(CONTENT)
  await converged(a, b, "the content to reach b")
  return { pa, pb, a, b }
}

const json = (editor: Editor) => JSON.stringify(editor.state.doc.toJSON())

async function converged(a: Editor, b: Editor, what: string) {
  await waitFor(() => json(a) === json(b), { what })
}

/** Every block id the editor's doc holds (top-level blocks and list items, any depth). */
function blockIds(editor: Editor): string[] {
  const ids: string[] = []
  editor.state.doc.descendants((node, _pos, parent) => {
    const listItem = node.type.name === "listItem"
    if (parent === editor.state.doc || listItem) ids.push(node.attrs["data-block-id"])
    return !node.isTextblock
  })
  return ids
}

function expectUniqueIds(editor: Editor) {
  const ids = blockIds(editor)
  for (const id of ids) expect(typeof id === "string" && id.length >= 10, `id ${id}`).toBe(true)
  expect(new Set(ids).size).toBe(ids.length)
}

function blockNamed(editor: Editor, type: string, text: string): TopLevelBlock {
  let found: TopLevelBlock | null = null
  editor.state.doc.forEach((node, offset, index) => {
    if (!found && node.type.name === type && node.textContent.startsWith(text)) found = { node, pos: offset, index }
  })
  if (!found) throw new Error(`no ${type} "${text}"`)
  return found
}

/** Yjs transactions this editor's own doc makes (the ySyncPlugin's), while `run` runs. */
function localTransactions(doc: Y.Doc, run: () => void): number {
  let count = 0
  const onTransaction = (tr: Y.Transaction) => {
    if (tr.local && tr.changed.size > 0) count++
  }
  doc.on("afterTransaction", onTransaction)
  run()
  doc.off("afterTransaction", onTransaction)
  return count
}

/** No more Yjs updates on either side for a while, and no local re-stamping on b. */
async function expectQuiet(pa: { doc: Y.Doc }, pb: { doc: Y.Doc }, b: Editor) {
  let updates = 0
  let localOnB = 0
  const count = () => updates++
  const onB = ({ transaction, appendedTransactions }: { transaction: any; appendedTransactions?: any[] }) => {
    for (const tr of [transaction, ...(appendedTransactions ?? [])]) if (tr.docChanged && !isChangeOrigin(tr)) localOnB++
  }
  pa.doc.on("update", count)
  pb.doc.on("update", count)
  b.on("transaction", onB)
  await new Promise((resolve) => setTimeout(resolve, 300))
  pa.doc.off("update", count)
  pb.doc.off("update", count)
  b.off("transaction", onB)
  expect(updates).toBe(0)
  expect(localOnB).toBe(0)
}

const stored = () => relay.api.posts.get(String(POST_ID))!.block_doc as BlockDocV1

async function storedHas(predicate: (doc: BlockDocV1) => boolean, what: string) {
  await waitFor(() => {
    const doc = stored()
    return !!doc && predicate(doc)
  }, { what })
  return stored()
}

function expectStoredIdsUnique(doc: BlockDocV1) {
  const listed = [...doc.blocks_order, ...Object.values(doc.blocks).flatMap((block) => block.children ?? [])]
  expect(new Set(listed).size).toBe(listed.length)
  for (const id of listed) expect(doc.blocks[id], `block ${id}`).toBeDefined()
}

describe("block menu with two editors on the Hocuspocus relay (#356)", () => {
  it("Duplicate: one transaction, a copy with fresh ids (nested items too) in both editors and the stored doc", async () => {
    const { pa, pb, a, b } = await twoEditors()
    const list = blockNamed(a, "bulletList", "one")
    const before = blockIds(a)

    const transactions = localTransactions(pa.doc, () => {
      expect(duplicateBlock(a, refOf(list))).not.toBeNull()
    })
    expect(transactions).toBe(1)
    await converged(a, b, "the copy to reach b")

    expect(a.state.doc.childCount).toBe(7)
    const copy = a.state.doc.child(5)
    const original = a.state.doc.child(4)
    expect(copy.textContent).toBe(original.textContent)
    expect(copy.type.name).toBe("bulletList")
    // Every id of the original stays where it was; the copy's are all new.
    expect(blockIds(a).filter((id) => before.includes(id))).toEqual(before)
    expectUniqueIds(a)
    expectUniqueIds(b)
    await expectQuiet(pa, pb, b)

    const doc = await storedHas((d) => d.blocks_order.length === 7, "the store of the copy")
    expectStoredIdsUnique(doc)
    const [first, second] = doc.blocks_order.slice(4, 6).map((id) => doc.blocks[id])
    expect(first.type).toBe("bullet_list")
    expect(second.type).toBe("bullet_list")
    expect(second.children).toHaveLength(2)
    expect(second.children!.some((id) => first.children!.includes(id))).toBe(false)
    expect(doc.blocks_order).toEqual(blockIds(a).filter((id) => doc.blocks_order.includes(id)))
  })

  it("Duplicate twice from both sides at once: ids stay unique everywhere", async () => {
    const { pa, pb, a, b } = await twoEditors()
    duplicateBlock(a, refOf(blockNamed(a, "paragraph", "alpha")))
    duplicateBlock(b, refOf(blockNamed(b, "paragraph", "alpha")))
    await converged(a, b, "both copies everywhere")
    expect(a.state.doc.childCount).toBe(8)
    expectUniqueIds(a)
    expectUniqueIds(b)
    await expectQuiet(pa, pb, b)
    expectStoredIdsUnique(await storedHas((d) => d.blocks_order.length === 8, "the store of both copies"))
  })

  it("Move to: the block and its children move under the heading in one transaction, keeping their ids", async () => {
    const { pa, pb, a, b } = await twoEditors()
    const list = blockNamed(a, "bulletList", "one")
    const listIds = blockIds(a).filter((id) => {
      let inList = false
      list.node.descendants((node) => {
        if (node.attrs["data-block-id"] === id) inList = true
      })
      return inList || id === list.node.attrs["data-block-id"]
    })
    const first = blockNamed(a, "heading", "First")

    const transactions = localTransactions(pa.doc, () => {
      expect(moveBlockUnder(a, refOf(list), refOf(first))).toBe(true)
    })
    expect(transactions).toBe(1)
    await converged(a, b, "the move to reach b")

    const order: string[] = []
    b.state.doc.forEach((node) => order.push(`${node.type.name}:${node.textContent}`))
    expect(order).toEqual(["heading:First", "bulletList:onetwonested", "paragraph:alpha", "heading:Second", "paragraph:beta", "paragraph:end"])
    // Same block, same ids.
    expect(b.state.doc.child(1).attrs["data-block-id"]).toBe(list.node.attrs["data-block-id"])
    for (const id of listIds) expect(blockIds(b)).toContain(id)
    expectUniqueIds(a)
    expectUniqueIds(b)
    await expectQuiet(pa, pb, b)

    const doc = await storedHas((d) => d.blocks_order[1] === list.node.attrs["data-block-id"], "the store of the move")
    expectStoredIdsUnique(doc)
    expect(doc.blocks[doc.blocks_order[1]].children).toHaveLength(2)
  })

  it("Move to finds the blocks by id: a collaborator's edit before it runs moves the right block", async () => {
    const { pa, pb, a, b } = await twoEditors()
    // a opens the menu on "beta" (by id), then b inserts a block at the top, shifting
    // every position, before a picks "First".
    const beta = refOf(blockNamed(a, "paragraph", "beta"))
    const first = refOf(blockNamed(a, "heading", "First"))
    b.commands.insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: "new top" }] })
    await converged(a, b, "b's insert to reach a")
    expect(topLevelBlockAt(a.state.doc, beta.pos)?.node.textContent).not.toBe("beta")

    expect(moveBlockUnder(a, beta, first)).toBe(true)
    await converged(a, b, "the move to reach b")
    const texts: string[] = []
    b.state.doc.forEach((node) => texts.push(node.textContent))
    expect(texts.slice(0, 4)).toEqual(["new top", "First", "beta", "alpha"])
    expectUniqueIds(b)
    await expectQuiet(pa, pb, b)
  })

  it("Colour: one attribute change, stored on the block (not its pm), and quiet", async () => {
    const { pa, pb, a, b } = await twoEditors()
    const alpha = blockNamed(a, "paragraph", "alpha")
    const transactions = localTransactions(pa.doc, () => {
      expect(setBlockColor(a, refOf(alpha), "blue-background")).toBe(true)
    })
    expect(transactions).toBe(1)
    await converged(a, b, "the colour to reach b")
    expect(blockNamed(b, "paragraph", "alpha").node.attrs.blockColor).toBe("blue-background")
    await expectQuiet(pa, pb, b)

    const id = alpha.node.attrs["data-block-id"]
    const doc = await storedHas((d) => (d.blocks[id]?.attrs as any)?.blockColor === "blue-background", "the store of the colour")
    expect((doc.blocks[id].attrs as any).pm.attrs).not.toHaveProperty("blockColor")
    // Untinted blocks gain nothing: no "blockColor": null anywhere in the stored doc.
    expect(JSON.stringify(doc)).not.toContain('"blockColor":null')
  })
})
