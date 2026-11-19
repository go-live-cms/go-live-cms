import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import Collaboration from "@tiptap/extension-collaboration"
import { BlockIdExtension } from "@gl-admin/components/editor/extensions/BlockIdExtension"
import { paragraphDoc, paragraphs } from "../../../collab-server/testkit"
import type { BlockDocV1 } from "../blocks-spec"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import { CollabSaveStatus } from "./CollabSaveStatus"
import { EDITOR_FRAGMENT } from "./fragmentBridge"
import { canonical } from "./fragmentBridge.fixtures"
import { META_MAP, type HocuspocusCollaboration, type StoreMessage } from "./HocuspocusCollaboration"
import { startRelay, waitFor, type Relay } from "./hocuspocusRelay.testkit"
import { findUnbuildableTypes } from "./schemaGuard"
import { textOf } from "./testHelpers"

// Server-side restore (#286): the API's POST /posts/:id/versions/:no/restore calls the
// collab server's internal restore, which puts the version into the live doc through a
// direct connection and stores it. These run the real server in-process (the relay) and
// call `server.restore` as the internal listener does, with the API faked in memory:
//   - with nobody connected (the doc is loaded for it, stored, unloaded);
//   - with two editors connected and typing while it lands (both converge, nothing lost
//     outside the blocks it replaces, nothing duplicated);
//   - after a collab restart, and across one (no duplication on reload);
//   - on a reseeded doc (a stale epoch): the old tab is refused, a fresh one sees the version;
//   - failures (store down, load down, bad version, no post, a template): nothing changes.

let relay: Relay
const editors: Editor[] = []

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  relay = await startRelay({ blockDoc: canonical(paragraphDoc("current one", "current two")), revision: 4 })
})

afterEach(async () => {
  while (editors.length) editors.pop()!.destroy()
  await relay.destroy()
  vi.restoreAllMocks()
})

async function peer(userId: string): Promise<{ editor: Editor; collab: HocuspocusCollaboration; status: CollabSaveStatus }> {
  const collab = relay.client(userId)
  await collab.whenSynced()
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit.configure({ undoRedo: false }), BlockIdExtension, Collaboration.configure({ document: collab.doc })],
  })
  editors.push(editor)
  return { editor, collab, status: new CollabSaveStatus(collab) }
}

const post = () => relay.api.posts.get("12")!
const stored = () => post().block_doc!
/** Each top-level block of the stored block_doc: a paragraph's text, any other block's type. */
const storedTypes = () =>
  stored().blocks_order.map((id) => {
    const block = stored().blocks[id]
    return block.type === "paragraph" ? textOf(block) ?? "" : block.type
  })
const restore = (version: unknown, userId = "2") => relay.server.restore("post-12", version, { userId, requestId: "restore-test" })
const loaded = () => relay.server.hocuspocus.documents.has("post-12")

const GONE_ALERT = "theme:gone/alert"

/**
 * A stored version: two paragraphs (the same ids as the post's, other text), an empty code
 * block the editor can't show (#213) and a block of a theme this build doesn't have (#453).
 */
function versionDoc(): BlockDocV1 {
  const doc = canonical(paragraphDoc("version one", "version two"))
  const [first, second] = doc.blocks_order
  doc.blocks_order = [first, "blk-version-code", "blk-gone-alert01", second]
  doc.blocks["blk-version-code"] = { id: "blk-version-code", type: "code_block", version: 1, attrs: { code: "" } } as unknown as BlockDocV1["blocks"][string]
  doc.blocks["blk-gone-alert01"] = {
    id: "blk-gone-alert01",
    type: GONE_ALERT,
    version: 1,
    attrs: { pm: { type: GONE_ALERT, content: [{ type: "text", text: "kept" }] }, text: "kept" },
  } as unknown as BlockDocV1["blocks"][string]
  return doc
}

describe("server-side restore (#286)", () => {
  it("restores with nobody connected: stored, the hidden blocks kept, the doc unloaded again", async () => {
    expect(loaded()).toBe(false)
    const result = await restore(versionDoc())
    expect(result).toEqual({ ok: true, revision: 5, block_doc: "written", dropped: 2 })

    // block_doc has the version, with the two blocks the editor can't show merged back.
    expect(storedTypes()).toEqual(["version one", "code_block", GONE_ALERT, "version two"])
    expect(stored().blocks["blk-gone-alert01"]).toEqual(versionDoc().blocks["blk-gone-alert01"])
    // Attributed to the user who restored it (#328): the blocks it changed.
    expect(relay.api.editorsOf("12")).toMatchObject({ [stored().blocks_order[0]]: 2, [stored().blocks_order[3]]: 2 })
    // The stored state holds it too, with the dropped record, and the doc isn't kept in memory.
    const state = relay.api.storedDoc("12")
    expect(paragraphs(state)).toEqual(["version one", "version two"])
    expect((state.getMap(META_MAP).get("dropped") as { entries: { id: string }[] }).entries.map((e) => e.id)).toEqual([
      "blk-version-code",
      "blk-gone-alert01",
    ])
    await waitFor(() => !loaded(), { what: "the doc to unload" })

    // An editor opening it later gets the version and can bind it: nothing in the fragment
    // its schema can't build (rule 10), the uninstalled theme's block stays hidden.
    const a = await peer("1")
    expect(paragraphs(a.collab.doc)).toEqual(["version one", "version two"])
    expect(findUnbuildableTypes(a.collab.doc.getXmlFragment(EDITOR_FRAGMENT), getInstalledCollabSchema())).toBeNull()
    expect(a.editor.getText()).toContain("version two")
  })

  it("reaches open editors live, like a remote edit, with a stored message", async () => {
    const a = await peer("1")
    const b = await peer("2")
    const messages: StoreMessage[] = []
    a.collab.onStore((message) => messages.push(message))

    const result = await restore(versionDoc())
    expect(result.ok).toBe(true)
    await waitFor(() => a.editor.getText().includes("version two") && b.editor.getText().includes("version two"), { what: "both editors" })
    expect(paragraphs(a.collab.doc)).toEqual(["version one", "version two"])
    expect(paragraphs(b.collab.doc)).toEqual(["version one", "version two"])
    await waitFor(() => messages.some((m) => m.type === "stored" && m.block_doc === "written" && m.revision === 5), { what: "stored" })
    // A remote change: neither editor is left "saving".
    expect(a.status.getState()).not.toBe("saving")
    expect(b.status.getState()).not.toBe("saving")
  })

  it("two editors typing while it lands converge on the version plus their typing, nothing duplicated", async () => {
    const a = await peer("1")
    const b = await peer("2")
    // Each types into the first paragraph, which the version keeps by id (its text changes).
    const typed = { a: 0, b: 0 }
    const typeInto = (editor: Editor, char: "a" | "b") => {
      const end = editor.state.doc.firstChild!.nodeSize - 1
      editor.commands.insertContentAt(end, char)
      typed[char]++
    }
    let typing = true
    const loop = (editor: Editor, char: "a" | "b") =>
      (async () => {
        while (typing) {
          typeInto(editor, char)
          await new Promise((resolve) => setTimeout(resolve, 3))
        }
      })()
    const loops = [loop(a.editor, "a"), loop(b.editor, "b")]
    await new Promise((resolve) => setTimeout(resolve, 30))
    const result = await restore(canonical(paragraphDoc("version one", "version two")))
    await new Promise((resolve) => setTimeout(resolve, 30))
    typing = false
    await Promise.all(loops)
    expect(result.ok).toBe(true)

    await waitFor(() => paragraphs(a.collab.doc).join("|") === paragraphs(b.collab.doc).join("|"), { what: "convergence" })
    const [first, second, ...rest] = paragraphs(a.collab.doc)
    expect(rest).toEqual([])
    expect(second).toBe("version two")
    // The version's text is there exactly once. Keystrokes the server had when it copied
    // the doc were in the text the version replaced (gone, like any text a concurrent edit
    // deletes); the ones typed meanwhile survive around it. Yjs orders concurrent inserts
    // at one position by client id, so some may sit before it: y-tiptap's text diff
    // replaces the whole run, and Y.Text inserts after the deleted characters.
    expect(first.split("version one")).toHaveLength(2)
    const typedSurvivors = first.replace("version one", "")
    expect(typedSurvivors).toMatch(/^[ab]*$/)
    expect(typedSurvivors.length).toBeLessThanOrEqual(typed.a + typed.b)
    expect(a.editor.getText()).toBe(b.editor.getText())

    // The next store holds exactly what both editors show.
    await waitFor(() => paragraphs(relay.api.storedDoc("12")).join("|") === paragraphs(a.collab.doc).join("|"), { what: "the store" })
    expect(storedTypes()).toEqual([first, second])
  })

  it("keeps a peer's typing in a block the version doesn't change", async () => {
    const a = await peer("1")
    // The version keeps the first paragraph as it is and changes the second.
    const result = await restore(canonical(paragraphDoc("current one", "version two")))
    expect(result.ok).toBe(true)
    await waitFor(() => paragraphs(a.collab.doc)[1] === "version two", { what: "the restore" })
    a.editor.commands.insertContentAt(a.editor.state.doc.firstChild!.nodeSize - 1, "!")
    await waitFor(() => storedTypes()[0] === "current one!", { what: "the store" })
    expect(storedTypes()).toEqual(["current one!", "version two"])
  })

  it("works after a collab restart, and survives the next one without duplicating anything", async () => {
    const a = await peer("1")
    await relay.restart()
    await waitFor(() => a.collab.synced, { what: "the reconnect" })

    expect((await restore(versionDoc())).ok).toBe(true)
    await waitFor(() => paragraphs(a.collab.doc).join("|") === "version one|version two", { what: "the editor" })

    await relay.restart()
    await waitFor(() => a.collab.synced, { what: "the second reconnect" })
    expect(a.collab.stale).toBe(false)
    expect(paragraphs(a.collab.doc)).toEqual(["version one", "version two"])
    const fresh = relay.client("2")
    await fresh.whenSynced()
    expect(paragraphs(fresh.doc)).toEqual(["version one", "version two"])
    expect(storedTypes()).toEqual(["version one", "code_block", GONE_ALERT, "version two"])
  })

  it("on a reseeded doc (stale epoch) the old tab is refused and never merges into the restored doc", async () => {
    const a = relay.client("1")
    await a.whenSynced()
    const oldEpoch = a.getEpoch()
    const onStale = vi.fn()
    a.onStale(onStale)

    // block_doc written around the server while it was down: the next load reseeds under a
    // new epoch. The restore is what loads it here (or joins the old tab's load).
    await relay.restart(() => {
      relay.api.writeAround("12", canonical(paragraphDoc("written around")))
    })
    const result = await restore(canonical(paragraphDoc("version one", "version two")))
    expect(result).toMatchObject({ ok: true, block_doc: "written" })
    await waitFor(() => onStale.mock.calls.length === 1, { what: "stale-epoch" })
    expect(a.destroyed).toBe(true)

    const fresh = relay.client("1")
    await fresh.whenSynced()
    expect(fresh.getEpoch()).not.toBe(oldEpoch)
    expect(paragraphs(fresh.doc)).toEqual(["version one", "version two"])
    expect(storedTypes()).toEqual(["version one", "version two"])
  })

  it("a failed store applies nothing: not to the live doc, its state or block_doc", async () => {
    const a = await peer("1")
    const before = structuredClone(stored())
    const stateBefore = post().state
    relay.api.failPut = true
    const result = await restore(versionDoc())
    expect(result).toMatchObject({ ok: false, reason: "unavailable" })
    relay.api.failPut = false

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(paragraphs(a.collab.doc)).toEqual(["current one", "current two"])
    expect(a.collab.doc.getMap(META_MAP).has("dropped")).toBe(false)
    expect(stored()).toEqual(before)
    expect(post().state).toBe(stateBefore)

    // The doc goes on as before: the next edit stores normally, without the version.
    a.editor.commands.insertContentAt(a.editor.state.doc.firstChild!.nodeSize - 1, "!")
    await waitFor(() => storedTypes()[0] === "current one!", { what: "the store" })
    expect(storedTypes()).toEqual(["current one!", "current two"])
  })

  it("a load failure, a missing post, a bad version or a template change nothing", async () => {
    relay.api.failGet = true
    expect(await restore(versionDoc())).toMatchObject({ ok: false, reason: "unavailable" })
    relay.api.failGet = false
    expect(post().block_revision).toBe(4)
    expect(relay.api.puts).toHaveLength(0)

    expect(await relay.server.restore("post-99", versionDoc(), { userId: "2" })).toMatchObject({ ok: false, reason: "not-found" })
    expect(await restore({ blocks: "nope" })).toMatchObject({ ok: false, reason: "invalid-version" })
    expect(await restore("not a doc")).toMatchObject({ ok: false, reason: "invalid-version" })
    expect(await relay.server.restore("template-12", versionDoc(), { userId: "1" })).toMatchObject({ ok: false, reason: "not-a-post" })
    expect(post().block_revision).toBe(4)
    expect(relay.api.puts).toHaveLength(0)
  })

  it("an empty version empties the working copy (one empty paragraph)", async () => {
    const a = await peer("1")
    expect(await restore({})).toMatchObject({ ok: true, block_doc: "written", dropped: 0 })
    await waitFor(() => a.editor.getText() === "", { what: "the editor" })
    expect(stored().blocks_order).toHaveLength(1)
    expect(textOf(stored().blocks[stored().blocks_order[0]])).toBeFalsy()
  })

  it("restoring the working copy as it is writes no new block_doc", async () => {
    await restore(canonical(paragraphDoc("version one")))
    const revision = post().block_revision
    expect(await restore(canonical(paragraphDoc("version one")))).toMatchObject({ ok: true, block_doc: "unchanged", revision })
    expect(post().block_revision).toBe(revision)
  })
})
