import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { themeBlockLookup } from "@gl-admin/lib/blocks-spec/themeBlocks"
import { getInstalledCollabSchema } from "./collabSchema"
import { installedThemeBlocks } from "./installed"
import { installedThemeBlockEditors } from "./editorBlocks"
import alert from "../../../themes/example/blocks/Alert/index"

// The example theme's alert block (#376) with two collaborators on the real collab server
// (in process): inserted by one user from the slash menu, edited by both, in the other
// user's editor, in the stored block_doc, and back after a server restart.

// jsdom has no layout: ProseMirror's scrollIntoView (the slash command focuses) needs
// these (same stubs as Editor.test.tsx).
const emptyRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) })
Range.prototype.getClientRects ??= function () {
  return Object.assign([], { item: () => null }) as unknown as DOMRectList
}
Range.prototype.getBoundingClientRect ??= emptyRect as unknown as () => DOMRect

const editors: Editor[] = []

// The editor's schema extensions plus every installed theme block, as the admin builds
// them (the headless nodes: the React node views need a mounted EditorContent).
function makeEditor(doc: Y.Doc): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: true })),
      ...installedThemeBlocks.map((block) => block.node),
      Collaboration.configure({ document: doc }),
    ],
  })
  editors.push(editor)
  return editor
}

const PARA = "blk-0376-para-0000001"
const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [PARA],
  blocks: { [PARA]: { id: PARA, type: "paragraph", version: 1, attrs: { text: "start" } } },
}

const alertPos = (editor: Editor): number => {
  let found = -1
  editor.state.doc.forEach((node, offset) => {
    if (found === -1 && node.type.name === alert.type) found = offset
  })
  return found
}

describe("the example theme's alert block on the Hocuspocus relay (#376)", () => {
  let relay: Relay
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    relay = await startRelay({ blockDoc: canonical(seed), revision: 2 })
  })
  afterEach(async () => {
    while (editors.length) editors.pop()!.destroy()
    await relay.destroy()
    vi.restoreAllMocks()
  })

  it("one user inserts it; the other user and the stored block_doc have it, and it survives a restart", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("start"), { what: "b to load" })

    // A: the slash menu's entry, at the end of the doc, then text.
    const slash = installedThemeBlockEditors.find((editor) => editor.type === alert.type)!.slash
    const end = a.state.doc.content.size
    a.commands.setTextSelection(end - 1)
    slash.command({ editor: a, range: { from: end - 1, to: end - 1 } })
    expect(alertPos(a)).toBeGreaterThan(-1)
    a.commands.insertContent("Mind the gap")

    // B sees it, and changes its variant (what the node view's select does).
    await waitFor(() => alertPos(b) > -1 && b.state.doc.nodeAt(alertPos(b))!.textContent === "Mind the gap", { what: "the alert on b" })
    expect(b.state.doc.nodeAt(alertPos(b))!.attrs.variant).toBe("info")
    b.commands.setTextSelection(alertPos(b) + 2)
    b.commands.updateAttributes(alert.type, { variant: "warning" })
    await waitFor(() => a.state.doc.nodeAt(alertPos(a))!.attrs.variant === "warning", { what: "warning on a" })
    await waitFor(() => JSON.stringify(b.state.doc.toJSON()) === JSON.stringify(a.state.doc.toJSON()), { what: "convergence" })

    // The stored block_doc has the block, in canonical shape, valid against its spec.
    const stored = () => relay.api.posts.get("12")!.block_doc!
    const storedAlert = () => Object.values(stored().blocks).find((block) => block.type === alert.type)
    await waitFor(() => (storedAlert()?.attrs as any)?.variant === "warning" && (storedAlert()?.attrs as any)?.text === "Mind the gap", {
      what: "the store",
    })
    const doc = stored()
    expect(() => validateBlockDoc(doc, { themeBlocks: themeBlockLookup(getInstalledCollabSchema()) })).not.toThrow()
    const block = storedAlert()!
    expect(block).toMatchObject({ type: "theme:example/alert", version: 1, attrs: { variant: "warning", text: "Mind the gap" } })
    expect((block.attrs as any).pm).toEqual({ type: alert.type, content: [{ type: "text", text: "Mind the gap" }] })
    // After the paragraph it was inserted below (TipTap's TrailingNode may add one after it).
    expect(doc.blocks_order.indexOf(block.id)).toBeGreaterThan(doc.blocks_order.indexOf(PARA))

    // After a restart (state from the store), a third user gets the same doc.
    const before = a.state.doc.toJSON()
    while (editors.length) editors.pop()!.destroy()
    await relay.restart()
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => c.getText().includes("Mind the gap"), { what: "c to load" })
    expect(c.state.doc.toJSON()).toEqual(before)
  })

  it("a block_doc with the alert seeds it for every editor (server seed, not the client)", async () => {
    const ALERT = "blk-0376-alert-000001"
    // As the API stores it (canonical() converts on the core schema, which has no alert).
    relay.api.addPost(
      "12",
      {
        doc_version: 1,
        blocks_order: [PARA, ALERT],
        blocks: {
          ...seed.blocks,
          [ALERT]: { id: ALERT, type: alert.type, version: 1, attrs: { variant: "success", text: "Saved" } },
        },
      },
      3,
    )
    const pa = relay.client("1")
    await pa.whenSynced()
    const a = makeEditor(pa.doc)
    await waitFor(() => a.getText().includes("Saved"), { what: "a to load" })
    expect(a.state.doc.nodeAt(alertPos(a))!.attrs).toEqual({ variant: "success", "data-block-id": ALERT })
  })
})
