import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { isBlockNode, validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "@/components/BlockRenderer"
import { BlockNodeViews } from "./BlockNodeViews"

// Embeds with two users on the real collab server (#425): one points a block at a link
// while the other types its caption; both converge, ids stay unique, the stored block_doc
// holds only a provider, a ref, a title and a caption, a restart reseeds the same doc, and
// that doc renders as a placeholder. Loading a player is one person's view, never the doc's.

const editors: Editor[] = []
let relay: Relay

function makeEditor(doc: Y.Doc): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [...Object.values(schemaExtensions({ collaborating: true })), BlockNodeViews, Collaboration.configure({ document: doc })],
  })
  editors.push(editor)
  return editor
}

const EMBED = "blk-0425-embed-000001"
const AFTER = "blk-0425-after-000001"

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [EMBED, AFTER],
  blocks: {
    [EMBED]: { id: EMBED, type: "embed", version: 1, attrs: { provider: "youtube" } },
    [AFTER]: { id: AFTER, type: "paragraph", version: 1, attrs: { text: "after" } },
  },
}

function blockIds(doc: PMNode): unknown[] {
  const ids: unknown[] = []
  doc.forEach((child) => {
    if (isBlockNode(child.type.name, null)) ids.push(child.attrs["data-block-id"])
  })
  return ids
}

const same = (a: Editor, b: Editor) => JSON.stringify(a.state.doc.toJSON()) === JSON.stringify(b.state.doc.toJSON())

function setLink(editor: Editor) {
  const node = editor.state.doc.child(0)
  editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { ...node.attrs, provider: "youtube", ref: "dQw4w9WgXcQ", title: "Two editors" }))
}

describe("embeds with two users on the relay (#425)", () => {
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

  const stored = () => relay.api.posts.get("12")!.block_doc!

  it("their edits merge, and the stored block holds a provider, a ref, a title and a caption", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("after"), { what: "b to load" })
    expect(a.state.doc.child(0).type.name).toBe("embed")

    // At the same time: A resolves the link; B adds a caption and types in it.
    setLink(a)
    b.view.dispatch(b.state.tr.setSelection(NodeSelection.create(b.state.doc, 0)))
    b.commands.toggleEmbedCaption()
    b.commands.insertContent("A demo")

    await waitFor(() => same(a, b) && a.getText().includes("A demo") && b.state.doc.child(0).attrs.ref === "dQw4w9WgXcQ", { what: "convergence" })
    const ids = blockIds(a.state.doc)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(blockIds(b.state.doc))

    await waitFor(() => (stored().blocks[EMBED]?.attrs as any)?.ref === "dQw4w9WgXcQ" && (stored().blocks[EMBED]?.attrs as any)?.caption?.length === 1, { what: "the store" })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(doc.blocks[EMBED]).toEqual({
      id: EMBED,
      type: "embed",
      version: 1,
      attrs: { provider: "youtube", ref: "dQw4w9WgXcQ", title: "Two editors", caption: [{ type: "text", text: "A demo" }] },
    })

    // The stored doc is what the public page renders: no request until a click.
    const html = renderToStaticMarkup(React.createElement(BlockRenderer, { doc }))
    expect(html).toContain("Two editors")
    expect(html).not.toMatch(/<iframe|https?:/)
  })

  it("loading a player changes nothing for anyone else, and stores nothing", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("after"), { what: "b to load" })
    setLink(a)
    await waitFor(() => b.state.doc.child(0).attrs.ref === "dQw4w9WgXcQ", { what: "b to get the link" })
    await waitFor(() => (stored().blocks[EMBED]?.attrs as any)?.ref === "dQw4w9WgXcQ", { what: "the store" })
    const revision = relay.api.posts.get("12")!.block_revision

    a.view.dom.querySelector<HTMLButtonElement>("figure[data-type='embed'] button")!.click()
    expect(a.view.dom.querySelector("iframe")).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(b.view.dom.querySelector("iframe")).toBeNull()
    expect(same(a, b)).toBe(true)
    expect(relay.api.posts.get("12")!.block_revision).toBe(revision)
  })

  it("survives a collab server restart: the reseeded doc has the same values", async () => {
    const pa = relay.client("1")
    await pa.whenSynced()
    const a = makeEditor(pa.doc)
    await waitFor(() => a.getText().includes("after"), { what: "a to load" })
    setLink(a)
    await waitFor(() => (stored().blocks[EMBED]?.attrs as any)?.ref === "dQw4w9WgXcQ", { what: "the store" })

    await relay.restart()
    const pb = relay.client("2")
    await pb.whenSynced()
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("after"), { what: "b to load after the restart" })
    expect(b.state.doc.child(0).attrs).toMatchObject({ "data-block-id": EMBED, provider: "youtube", ref: "dQw4w9WgXcQ", title: "Two editors" })
  })
})
