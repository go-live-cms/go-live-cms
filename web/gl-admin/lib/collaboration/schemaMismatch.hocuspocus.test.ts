// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Node } from "@tiptap/core"
import { appendParagraph, connect, paragraphDoc, paragraphs } from "../../../collab-server/testkit"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import { installedThemeBlocks } from "../theme-blocks/installed"
import { canonical } from "./fragmentBridge.fixtures"
import { EDITOR_FRAGMENT } from "./fragmentBridge"
import { DENY_REASON, type CollabAccess } from "./HocuspocusCollaboration"
import { startRelay, waitFor, type Relay } from "./hocuspocusRelay.testkit"
import { getCollabSchema } from "./schema"
import { schemaFingerprint } from "./schemaFingerprint"

// The schema fingerprint guard (#416), against the real collab server in-process. Rule 10
// covers types present when an editor binds; this covers a peer inserting a new type
// after an older editor tab bound: that tab is refused at its next connect
// (`schema-mismatch`), so it never syncs, never binds, and y-tiptap on it never meets
// (and deletes) a type it can't build.

/** A node type the "new" bundle has and the installed (old) one doesn't: a new block. */
const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "inline*",
  addAttributes: () => ({ "data-block-id": { default: null } }),
})
const NEW_SCHEMA = getCollabSchema([...installedThemeBlocks.map((block) => block.node), Callout])
/** What a tab still on the bundle from before the deploy sends. */
const OLD_FINGERPRINT = schemaFingerprint(getInstalledCollabSchema())

const DOC = "post-12"
const CALLOUT_ID = "blk-callout-00001"

let relay: Relay

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(async () => {
  await relay?.destroy()
  vi.restoreAllMocks()
})

/** The server's ws_deny lines for schema-mismatch, parsed. */
const schemaDenies = () =>
  vi
    .mocked(console.warn)
    .mock.calls.map(([line]) => String(line))
    .filter((line) => line.includes('"ws_deny"') && line.includes(DENY_REASON.schemaMismatch))
    .map((line) => JSON.parse(line))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A callout appended to the editor fragment, as the new bundle's editor would insert it. */
function appendCallout(doc: Y.Doc, text: string, id = CALLOUT_ID) {
  const fragment = doc.getXmlFragment(EDITOR_FRAGMENT)
  doc.transact(() => {
    const callout = new Y.XmlElement("callout")
    fragment.insert(fragment.length, [callout])
    callout.setAttribute("data-block-id", id)
    callout.insert(0, [new Y.XmlText(text)])
  })
}

const nodeNames = (doc: Y.Doc) => doc.getXmlFragment(EDITOR_FRAGMENT).toArray().map((node) => (node as Y.XmlElement).nodeName)
const storedBlock = (id: string) => relay.api.posts.get("12")?.block_doc?.blocks[id]

describe("schema fingerprint guard (#416)", () => {
  it("a client on the server's schema connects and edits as before", async () => {
    relay = await startRelay({ blockDoc: canonical(paragraphDoc("one")), revision: 3 })
    const client = relay.client("2")
    await client.whenSynced()
    expect(paragraphs(client.doc)).toEqual(["one"])
    expect(client.getStatus()).toBe("connected")
    expect(client.outdated).toBe(false)
    expect(client.getAccess()).toEqual({ readOnly: false, reason: null, revoked: false })

    appendParagraph(client.doc, "two", "blk-para-two-0001")
    await waitFor(() => !!storedBlock("blk-para-two-0001"), { what: "the store" })
    expect(schemaDenies()).toEqual([])
  })

  it("refuses a client on another schema: outdated, read-only, never synced and never retried", async () => {
    relay = await startRelay({ blockDoc: canonical(paragraphDoc("one")), revision: 3, schema: NEW_SCHEMA })
    const client = relay.client("2", { schemaFingerprint: OLD_FINGERPRINT })
    const changes: CollabAccess[] = []
    client.onAccess((access) => changes.push(access))

    await waitFor(() => client.outdated, { what: "the refusal" })
    expect(client.getStatus()).toBe("outdated")
    expect(client.readOnly).toBe(true)
    expect(client.getAccess()).toEqual({ readOnly: true, reason: null, revoked: false, outdated: true })
    expect(changes).toEqual([client.getAccess()])

    // The relay retries an auth failure after 50ms and reconnects a socket after 50ms:
    // neither happens for this one.
    await sleep(600)
    expect(client.synced).toBe(false)
    expect(client.getStatus()).toBe("outdated")
    expect(schemaDenies()).toHaveLength(1)
    expect(schemaDenies()[0]).toMatchObject({
      user_id: "2",
      client_schema: OLD_FINGERPRINT.slice(0, 12),
      server_schema: relay.server.schemaFingerprint.slice(0, 12),
    })
    expect(relay.server.hocuspocus.getConnectionsCount()).toBe(0)
  })

  it("refuses a client that sends no fingerprint (a bundle from before #416), and never logs its ticket", async () => {
    relay = await startRelay({ blockDoc: canonical(paragraphDoc("one")), revision: 3 })
    const ticket = await relay.ticket("2")
    const legacy = connect(relay.url, DOC, () => ticket, { schema: null })
    try {
      expect(await legacy.outcome).toEqual({ synced: false, reason: DENY_REASON.schemaMismatch })
    } finally {
      legacy.destroy()
    }
    expect(schemaDenies()).toEqual([expect.objectContaining({ client_schema: "missing", user_id: "2" })])
    const logged = vi.mocked(console.warn).mock.calls.map(([line]) => String(line)).join("\n")
    expect(logged).not.toContain(ticket.slice(10, 60))
    expect(relay.api.accessCalls).toBe(0)
  })

  it("writes nothing to the shared doc before refusing, even for a client holding edits", async () => {
    // No stored state: a connect that got as far as loading the doc would seed it and store
    // the seed right away.
    relay = await startRelay({ blockDoc: canonical(paragraphDoc("one", "two")), revision: 3 })
    // The server runs the installed schema; this tab another one (here a newer bundle, as
    // after a rollback of the collab server: the guard works both ways).
    const stale = relay.client("2", { schemaFingerprint: schemaFingerprint(NEW_SCHEMA) })
    // Typed before it connected (its edits are in the Y.Doc when the sync would start).
    appendParagraph(stale.doc, "offline edit", "blk-offline-00001")

    await waitFor(() => stale.outdated, { what: "the refusal" })
    await sleep(300)
    expect(relay.api.puts).toEqual([])
    expect(relay.api.accessCalls).toBe(0)
    expect(relay.server.hocuspocus.documents.size).toBe(0)
    expect(relay.server.hocuspocus.loadingDocuments.size).toBe(0)
    // Kept locally (nothing is stored on the device, rule 0: a reload drops it).
    expect(paragraphs(stale.doc)).toEqual(["offline edit"])

    // The doc as the server has it: the edit never reached it.
    const fresh = relay.client("1")
    await fresh.whenSynced()
    expect(paragraphs(fresh.doc)).toEqual(["one", "two"])
    await relay.server.flush(DOC)
    expect(paragraphs(relay.api.storedDoc("12"))).toEqual(["one", "two"])
  })

  it("an old-schema tab never deletes a node type a new-schema peer inserts", async () => {
    relay = await startRelay({ blockDoc: canonical(paragraphDoc("intro")), revision: 3, schema: NEW_SCHEMA })
    const peer = relay.client("1")
    await peer.whenSynced()
    const old = relay.client("2", { schemaFingerprint: OLD_FINGERPRINT })
    appendCallout(peer.doc, "Careful")

    await waitFor(() => old.outdated, { what: "the old tab's refusal" })
    await waitFor(() => storedBlock(CALLOUT_ID)?.type === "callout", { what: "the callout to be stored" })
    await sleep(300)
    // The old tab never got the callout, so y-tiptap there had nothing to delete.
    expect(old.doc.getXmlFragment(EDITOR_FRAGMENT).length).toBe(0)
    expect(nodeNames(peer.doc)).toEqual(["paragraph", "callout"])

    // After a restart (store, unload, load from the stored state) it is all still there.
    await relay.restart()
    const reader = relay.client("3")
    await reader.whenSynced()
    expect(nodeNames(reader.doc)).toEqual(["paragraph", "callout"])
    expect(storedBlock(CALLOUT_ID)).toMatchObject({ type: "callout", attrs: { text: "Careful" } })
  })

  it("a connected editor keeps its connection until it reconnects; after a deploy onto another schema it is refused and keeps its doc", async () => {
    relay = await startRelay({ blockDoc: canonical(paragraphDoc("intro")), revision: 3 })
    const tab = relay.client("2")
    await tab.whenSynced()
    appendParagraph(tab.doc, "typed before the deploy", "blk-before-00001")
    await waitFor(() => !!storedBlock("blk-before-00001"), { what: "the store" })
    const changes: CollabAccess[] = []
    tab.onAccess((access) => changes.push(access))

    // The deploy: the collab server restarts with the new bundle's schema. The tab's
    // connection drops with it, and its reconnect is refused.
    await relay.restart(undefined, { schema: NEW_SCHEMA })
    await waitFor(() => tab.outdated, { what: "the refusal on reconnect" })
    expect(changes).toEqual([{ readOnly: true, reason: null, revoked: false, outdated: true }])
    expect(paragraphs(tab.doc)).toEqual(["intro", "typed before the deploy"])

    // A tab on the new bundle inserts the new type; the old tab gets nothing more.
    const peer = relay.client("1")
    await peer.whenSynced()
    expect(paragraphs(peer.doc)).toEqual(["intro", "typed before the deploy"])
    appendCallout(peer.doc, "New block")
    await waitFor(() => storedBlock(CALLOUT_ID)?.type === "callout", { what: "the callout to be stored" })
    await sleep(300)
    expect(nodeNames(tab.doc)).toEqual(["paragraph", "paragraph"])
    expect(tab.getStatus()).toBe("outdated")
    expect(nodeNames(peer.doc)).toEqual(["paragraph", "paragraph", "callout"])
  })
})
