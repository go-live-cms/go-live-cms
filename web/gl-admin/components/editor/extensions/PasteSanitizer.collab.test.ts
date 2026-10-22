import { describe, it, expect, afterEach } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import Collaboration from "@tiptap/extension-collaboration"
import { BlockIdExtension } from "./BlockIdExtension"
import { PasteSanitizer } from "./PasteSanitizer"
import googleDocsHTML from "./__fixtures__/paste/google-docs.html?raw"

// Two collaborators: each editor is bound (TipTap Collaboration / ySyncPlugin) to its
// own Y.Doc, and a relay forwards every update to the other doc, like the WS server.
// A paste on one side must reach the other with the same block ids, and then go
// quiet: no BlockId re-stamping on the receiving side bouncing back (rule 7).

const editors: Editor[] = []

afterEach(() => {
  while (editors.length) editors.pop()!.destroy()
})

function makePeer(doc: Y.Doc): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit.configure({ undoRedo: false }), BlockIdExtension, PasteSanitizer, Collaboration.configure({ document: doc })],
  })
  editors.push(editor)
  return editor
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function settle() {
  for (let i = 0; i < 5; i++) await tick()
}

describe("PasteSanitizer with collaboration (#128)", () => {
  it("a paste syncs to the other peer with the same ids and doesn't loop", async () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    let updates = 0
    docA.on("update", (u: Uint8Array, origin: unknown) => {
      updates++
      if (origin !== "relay") Y.applyUpdate(docB, u, "relay")
    })
    docB.on("update", (u: Uint8Array, origin: unknown) => {
      updates++
      if (origin !== "relay") Y.applyUpdate(docA, u, "relay")
    })

    const a = makePeer(docA)
    const b = makePeer(docB)
    await settle()

    a.view.pasteHTML(googleDocsHTML, new Event("paste") as ClipboardEvent)
    await settle()

    expect(a.getText()).toContain("twelve percent")
    expect(b.state.doc.toJSON()).toEqual(a.state.doc.toJSON())
    a.state.doc.forEach((node) => {
      expect(typeof node.attrs["data-block-id"]).toBe("string")
    })

    // Quiescent: a full resync both ways (the 2s resyncInterval) changes nothing.
    const before = updates
    for (let i = 0; i < 3; i++) {
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), "relay")
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), "relay")
      await settle()
    }
    expect(updates).toBe(before)
    expect(b.state.doc.toJSON()).toEqual(a.state.doc.toJSON())
  })
})
