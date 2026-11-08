import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { InlineNodeViews } from "./InlineNodeViews"
import { PasteSanitizer } from "./PasteSanitizer"

// #320's inline nodes with two users on the real collab server: a mention, a content link
// and a reminder typed by one user reach the other as the same nodes, the stored block_doc
// keeps them (valid, with the ids the API reads), the store attributes their block to
// whoever typed them (#328: what the API's mention emails and reminders trust), a third
// user loads them, and they survive a restart.

vi.mock("@gl-admin/lib/api/mentions", () => ({
  getMentionPeople: vi.fn(async () => []),
  searchMentionPeople: vi.fn(async () => []),
  searchMentionContent: vi.fn(async () => []),
}))

const editors: Editor[] = []
let relay: Relay

function makeEditor(doc: Y.Doc): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [...Object.values(schemaExtensions({ collaborating: true })), InlineNodeViews, PasteSanitizer, Collaboration.configure({ document: doc })],
  })
  editors.push(editor)
  return editor
}

const P1 = "blk-0320-paragrph-0001"
const P2 = "blk-0320-paragrph-0002"

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [P1, P2],
  blocks: {
    [P1]: { id: P1, type: "paragraph", version: 1, attrs: { text: "Ask" } },
    [P2]: { id: P2, type: "paragraph", version: 1, attrs: { text: "by" } },
  },
}

const endOfBlock = (editor: Editor, index: number) => {
  let pos = 0
  for (let i = 0; i <= index; i++) pos += editor.state.doc.child(i).nodeSize
  return pos - 1
}
const inlineOf = (doc: BlockDocV1, id: string) => ((doc.blocks[id]?.attrs as any)?.pm?.content ?? []).filter((n: any) => n.type !== "text")

describe("mentions, content links and dates with two users on the relay (#320)", () => {
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    relay = await startRelay({ blockDoc: canonical(seed), revision: 2 })
  })
  afterEach(async () => {
    while (editors.length) {
      const editor = editors.pop()!
      const element = editor.options.element as HTMLElement
      editor.destroy()
      element.remove()
    }
    await relay.destroy()
    vi.restoreAllMocks()
  })

  it("reach the other user, are stored with their ids, attributed to their author, and load again", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("by"), { what: "b to load" })

    // A mentions someone and links a post in the first paragraph; B sets a reminder in the second.
    a.commands.setTextSelection(endOfBlock(a, 0))
    a.commands.insertContent(" ")
    a.commands.insertMention({ userId: 7, label: "Ana Costa" })
    a.commands.insertContentLink({ postId: 42, label: "The guide" })
    b.commands.setTextSelection(endOfBlock(b, 1))
    b.commands.insertContent(" ")
    b.commands.insertDateChip({ date: "2026-12-01", time: "10:30", reminder: true })

    const json = (e: Editor) => JSON.stringify(e.state.doc.toJSON())
    await waitFor(() => json(a) === json(b) && json(a).includes("dateChip") && json(b).includes("contentLink"), { what: "convergence" })
    // B shows A's mention through the view (the stored label until the name is known).
    expect(b.view.dom.querySelector('[data-type="mention"]')?.textContent).toBe("@Ana Costa")
    expect(b.view.dom.querySelector('[data-type="mention"]')?.getAttribute("data-user-id")).toBe("7")

    const stored = () => relay.api.posts.get("12")!.block_doc!
    await waitFor(() => inlineOf(stored(), P1).length === 2 && inlineOf(stored(), P2).length === 1, { what: "the store" })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(inlineOf(doc, P1)).toEqual([
      { type: "mention", attrs: { userId: 7, label: "Ana Costa" } },
      { type: "contentLink", attrs: { postId: 42, label: "The guide" } },
    ])
    expect(inlineOf(doc, P2)).toEqual([{ type: "dateChip", attrs: { date: "2026-12-01", time: "10:30", reminder: true } }])
    expect((doc.blocks[P1].attrs as any).text).toBe("Ask @Ana Costa The guide ")

    // The store says who changed each block: the API mails mentions and owns reminders by it.
    await waitFor(() => relay.api.blockEdits.get("12")?.get(P1)?.user_id === 1 && relay.api.blockEdits.get("12")?.get(P2)?.user_id === 2, {
      what: "attribution",
    })

    // A third user opening the post later gets the same nodes.
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => json(c).includes("dateChip"), { what: "c to load" })
    expect(c.state.doc.toJSON()).toEqual(a.state.doc.toJSON())
  })

  it("survive a collab server restart", async () => {
    const pa = relay.client("1")
    await pa.whenSynced()
    const a = makeEditor(pa.doc)
    await waitFor(() => a.getText().includes("by"), { what: "a to load" })
    a.commands.setTextSelection(endOfBlock(a, 0))
    a.commands.insertMention({ userId: 7, label: "Ana Costa" })
    const stored = () => relay.api.posts.get("12")!.block_doc!
    await waitFor(() => inlineOf(stored(), P1).length === 1, { what: "the store" })
    const before = stored()

    await relay.restart()
    const pb = relay.client("2")
    await pb.whenSynced()
    const b = makeEditor(pb.doc)
    await waitFor(() => JSON.stringify(b.state.doc.toJSON()).includes("mention"), { what: "b after the restart" })
    expect(inlineOf(before, P1)).toEqual([{ type: "mention", attrs: { userId: 7, label: "Ana Costa" } }])
    const node = b.state.doc.child(0).child(1)
    expect(node.type.name).toBe("mention")
    expect(node.attrs).toEqual({ userId: 7, label: "Ana Costa" })
  })
})
