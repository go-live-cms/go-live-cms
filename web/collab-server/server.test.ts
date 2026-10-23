// The real Hocuspocus server in-process, with real HocuspocusProviders over WebSockets
// and the #280 API contract stubbed in memory (FakeCollabApi). Covers convergence,
// seeding only when no state exists, restarts without duplication, the revision and
// epoch guards, read-only contributors, store failures and flush.
//
// In-process tests can't reproduce the dual yjs instance hazard (vitest resolves one
// yjs); process.test.ts spawns the real bundle for that.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as Y from "yjs"
import { canonical } from "../gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { verifyTicket } from "./access"
import { DENY } from "./auth"
import { readMeta } from "./load"
import { createCollabServer, type CollabServer } from "./server"
import { appendParagraph, connect, FakeCollabApi, ISSUER, paragraphDoc, paragraphs, ticketKeys, waitFor, type Client } from "./testkit"

const { publicKey, sign } = await ticketKeys()
const DOC = "post-12"

let api: FakeCollabApi
let servers: CollabServer[]
let clients: Client[]

async function startServer(options: { debounce?: number } = {}) {
  const collab = createCollabServer({
    api,
    verifyTicket: (ticket, docName) => verifyTicket(ticket, publicKey, { issuer: ISSUER, docName }),
    port: 0,
    address: "127.0.0.1",
    debounce: options.debounce ?? 50,
    maxDebounce: 500,
    storeRetryMs: 50,
  })
  servers.push(collab)
  const port = await collab.listen()
  return { collab, url: `ws://127.0.0.1:${port}` }
}

const ticketFor = (userId: string, doc = DOC) => () => sign({ user_id: userId, doc, iat: new Date().toISOString() })

function open(url: string, userId: string, opts: { epoch?: string; doc?: string } = {}) {
  const client = connect(url, opts.doc ?? DOC, ticketFor(userId, opts.doc), opts)
  clients.push(client)
  return client
}

async function synced(client: Client) {
  const outcome = await client.outcome
  if (!outcome.synced) throw new Error(`denied: ${outcome.reason}`)
  return outcome
}

/** Closes a client and waits until the server has unloaded the doc (stored first). */
async function closeAll(collab: CollabServer, ...list: Client[]) {
  list.forEach((client) => client.destroy())
  await waitFor(() => collab.hocuspocus.getDocumentsCount() === 0, { what: "the doc to unload" })
}

beforeEach(() => {
  api = new FakeCollabApi()
  api.users.set("1", { role: "admin" })
  api.users.set("2", { role: "editor" })
  api.users.set("3", { role: "contributor" })
  api.users.set("4", { role: "contributor", owns: ["12"] })
  api.users.set("5", { role: "subscriber" })
  api.addPost("12", canonical(paragraphDoc("one", "two")), 5)
  servers = []
  clients = []
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(async () => {
  clients.forEach((client) => client.destroy())
  await Promise.all(servers.map((collab) => collab.destroy(2000)))
  vi.restoreAllMocks()
})

describe("collab server (in-process Hocuspocus)", () => {
  it("two editors converge, and the store derives block_doc from both edits", async () => {
    const { url } = await startServer()
    const a = open(url, "1")
    const b = open(url, "2")
    await synced(a)
    await synced(b)
    expect(paragraphs(a.doc)).toEqual(["one", "two"])

    appendParagraph(a.doc, "from a", "blk-from-a-0001")
    appendParagraph(b.doc, "from b", "blk-from-b-0001")
    await waitFor(() => paragraphs(a.doc).length === 4 && paragraphs(b.doc).length === 4, { what: "convergence" })
    expect(paragraphs(a.doc)).toEqual(paragraphs(b.doc))

    await waitFor(() => (api.posts.get("12")!.block_doc?.blocks_order.length ?? 0) === 4, { what: "the store" })
    const post = api.posts.get("12")!
    expect(post.block_doc!.blocks_order).toEqual(expect.arrayContaining(["blk-from-a-0001", "blk-from-b-0001"]))
    expect(post.block_revision).toBe(6)
    expect(api.puts.at(-1)!.body.last_editor_id).toBeGreaterThan(0)
    await waitFor(() => a.stateless.some((m) => (m as { type: string }).type === "stored"), { what: "a stored message" })
    expect(a.stateless).toContainEqual({ type: "stored", revision: 6, block_doc: "written" })
  })

  it("seeds only when no state exists; a restart restores the stored state without duplication", async () => {
    const first = await startServer()
    const a = open(first.url, "2")
    await synced(a)
    // The seed is persisted right away (state + epoch, block_doc untouched).
    expect(api.puts).toHaveLength(1)
    expect(api.puts[0].body.block_doc).toBeUndefined()
    // A state-only store must name its base revision (the API answers 400 without it).
    expect(api.puts[0].body.base_revision).toBe(api.posts.get("12")!.block_revision)
    const epoch = api.posts.get("12")!.epoch
    appendParagraph(a.doc, "typed before restart", "blk-typed-00001")
    await closeAll(first.collab, a)
    await first.collab.destroy()

    const second = await startServer()
    const b = open(second.url, "2", { epoch: epoch! })
    await synced(b)
    expect(paragraphs(b.doc)).toEqual(["one", "two", "typed before restart"])
    expect(readMeta(b.doc).epoch).toBe(epoch)
    expect(api.posts.get("12")!.block_doc!.blocks_order).toHaveLength(3)

    // And again: still no duplication on a second restart.
    await closeAll(second.collab, b)
    await second.collab.destroy()
    const third = await startServer()
    const c = open(third.url, "1")
    await synced(c)
    expect(paragraphs(c.doc)).toEqual(["one", "two", "typed before restart"])
  })

  it("block_doc written around the server → reseed with a new epoch; the old epoch is refused", async () => {
    const first = await startServer()
    const a = open(first.url, "2")
    await synced(a)
    const oldEpoch = readMeta(a.doc).epoch!
    await closeAll(first.collab, a)

    api.writeAround("12", canonical(paragraphDoc("restored by an admin tool")))

    const stale = open(first.url, "2", { epoch: oldEpoch })
    expect(await stale.outcome).toEqual({ synced: false, reason: DENY.staleEpoch })

    const fresh = open(first.url, "2")
    await synced(fresh)
    expect(paragraphs(fresh.doc)).toEqual(["restored by an admin tool"])
    const newEpoch = readMeta(fresh.doc).epoch
    expect(newEpoch).not.toBe(oldEpoch)

    const current = open(first.url, "1", { epoch: newEpoch! })
    await synced(current)
  })

  it("a stale-epoch check doesn't leave the doc loaded", async () => {
    const { url, collab } = await startServer()
    const stale = open(url, "2", { epoch: "not-the-epoch" })
    expect(await stale.outcome).toEqual({ synced: false, reason: DENY.staleEpoch })
    await waitFor(() => collab.hocuspocus.getDocumentsCount() === 0, { what: "unload" })
  })

  it("a contributor on someone else's post is a live read-only peer", async () => {
    const { url } = await startServer()
    const editor = open(url, "2")
    const contributor = open(url, "3")
    await synced(editor)
    expect((await synced(contributor)).readOnly).toBe(true)

    appendParagraph(contributor.doc, "must not land", "blk-ignored-0001")
    appendParagraph(editor.doc, "editor typed", "blk-editor-00001")
    await waitFor(() => paragraphs(contributor.doc).includes("editor typed"), { what: "the editor's edit at the contributor" })
    await waitFor(() => api.posts.get("12")!.block_doc!.blocks_order.includes("blk-editor-00001"), { what: "the store" })
    expect(paragraphs(editor.doc)).not.toContain("must not land")
    expect(api.posts.get("12")!.block_doc!.blocks_order).not.toContain("blk-ignored-0001")
  })

  it("a contributor on their own post edits (#135); other roles and unknown users are refused", async () => {
    const { url } = await startServer()
    const owner = open(url, "4")
    expect((await synced(owner)).readOnly).toBe(false)
    expect(await open(url, "5").outcome).toEqual({ synced: false, reason: DENY.forbidden })
    expect(await open(url, "99").outcome).toEqual({ synced: false, reason: DENY.forbidden })
  })

  it("refuses when the API can't answer the access lookup", async () => {
    const { url } = await startServer()
    api.failAccess = true
    expect(await open(url, "2").outcome).toEqual({ synced: false, reason: DENY.unavailable })
  })

  it("refuses a ticket for another document and a replayed ticket", async () => {
    const { url } = await startServer()
    const other = connect(url, DOC, ticketFor("2", "post-13"))
    clients.push(other)
    expect(await other.outcome).toEqual({ synced: false, reason: DENY.forbidden })

    const ticket = await ticketFor("2")()
    const first = connect(url, DOC, () => ticket)
    clients.push(first)
    await synced(first)
    const replay = connect(url, DOC, () => ticket)
    clients.push(replay)
    expect(await replay.outcome).toEqual({ synced: false, reason: DENY.forbidden })
  })

  it("flush stores immediately (publish), and is a no-op for a doc that isn't loaded", async () => {
    const { url, collab } = await startServer({ debounce: 60_000 })
    expect(await collab.flush("post-99")).toEqual({ ok: true, skipped: true, loaded: false })
    const a = open(url, "2")
    await synced(a)
    appendParagraph(a.doc, "publish me", "blk-publish-0001")
    await waitFor(() => collab.hocuspocus.documents.get(DOC)!.getXmlFragment("default").length === 3, { what: "the edit" })
    expect(api.posts.get("12")!.block_doc!.blocks_order).toHaveLength(2)

    expect(await collab.flush(DOC)).toEqual({ ok: true, skipped: false, loaded: true })
    expect(api.posts.get("12")!.block_doc!.blocks_order).toContain("blk-publish-0001")
    // Nothing new: the next flush doesn't PUT again.
    const puts = api.puts.length
    expect(await collab.flush(DOC)).toEqual({ ok: true, skipped: true, loaded: true })
    expect(api.puts).toHaveLength(puts)
  })

  it("a failed store is reported, retried, and keeps the doc in memory until it succeeds", async () => {
    const { url, collab } = await startServer({ debounce: 60_000 })
    const a = open(url, "2")
    await synced(a)
    appendParagraph(a.doc, "unsaved", "blk-unsaved-0001")
    await waitFor(() => collab.hocuspocus.documents.get(DOC)!.getXmlFragment("default").length === 3, { what: "the edit" })

    api.failPut = true
    const result = await collab.flush(DOC)
    expect(result.ok).toBe(false)
    await waitFor(() => a.stateless.some((m) => (m as { type: string }).type === "store_failed"), { what: "store_failed" })

    // The last client leaves: the doc must not be dropped with the only copy of the edit.
    a.destroy()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(collab.hocuspocus.documents.has(DOC)).toBe(true)

    api.failPut = false
    await waitFor(() => api.posts.get("12")!.block_doc!.blocks_order.includes("blk-unsaved-0001"), { what: "the retry" })
    await waitFor(() => collab.hocuspocus.getDocumentsCount() === 0, { what: "unload after the retry" })
  })

  it("an edit that lands while a store's PUT is in flight is stored by the next store", async () => {
    const { url, collab } = await startServer({ debounce: 60_000 })
    const a = open(url, "2")
    await synced(a)
    const live = () => collab.hocuspocus.documents.get(DOC)!.getXmlFragment("default").length
    appendParagraph(a.doc, "first", "blk-first-00001")
    await waitFor(() => live() === 3, { what: "the first edit" })

    let release!: () => void
    api.beforePut = () => new Promise<void>((resolve) => (release = resolve))
    const inFlight = collab.flush(DOC)
    await waitFor(() => typeof release === "function", { what: "the PUT to start" })
    appendParagraph(a.doc, "during the PUT", "blk-during-0001")
    await waitFor(() => live() === 4, { what: "the second edit" })
    api.beforePut = null
    release()
    expect((await inFlight).ok).toBe(true)
    expect(api.posts.get("12")!.block_doc!.blocks_order).not.toContain("blk-during-0001")

    expect(await collab.flush(DOC)).toEqual({ ok: true, skipped: false, loaded: true })
    expect(api.posts.get("12")!.block_doc!.blocks_order).toContain("blk-during-0001")
  })

  it("a failed seed PUT is retried, so the epoch becomes durable", async () => {
    const { url, collab } = await startServer()
    api.failPut = true
    const reader = open(url, "3")
    await synced(reader)
    const epoch = readMeta(reader.doc).epoch
    expect(api.posts.get("12")!.epoch).toBeNull()
    reader.destroy()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(collab.hocuspocus.documents.has(DOC)).toBe(true)

    api.failPut = false
    await waitFor(() => api.posts.get("12")!.epoch === epoch, { what: "the seed retry" })
    await waitFor(() => collab.hocuspocus.getDocumentsCount() === 0, { what: "unload after the retry" })
  })

  it("an epoch check on a deleted post is a final refusal, not a retryable outage", async () => {
    const { url } = await startServer()
    api.posts.delete("12")
    expect(await open(url, "2", { epoch: "some-epoch" }).outcome).toEqual({ synced: false, reason: DENY.forbidden })
  })

  it("a doc that fails to load is refused, not seeded empty", async () => {
    const { url, collab } = await startServer()
    api.failGet = true
    const a = open(url, "2")
    const outcome = await Promise.race([a.outcome, new Promise((resolve) => setTimeout(() => resolve("pending"), 1500))])
    expect(outcome).not.toEqual(expect.objectContaining({ synced: true }))
    expect(api.puts).toHaveLength(0)
    await waitFor(() => collab.hocuspocus.getDocumentsCount() === 0, { what: "unload" })
  })

  it("stamps a block id an editor didn't set, once, in the live doc", async () => {
    const { url } = await startServer()
    const a = open(url, "2")
    await synced(a)
    a.doc.transact(() => {
      const p = new Y.XmlElement("paragraph")
      a.doc.getXmlFragment("default").insert(2, [p])
      p.insert(0, [new Y.XmlText("no id")])
    })
    await waitFor(() => api.posts.get("12")!.block_doc!.blocks_order.length === 3, { what: "the store" })
    const stamped = (a.doc.getXmlFragment("default").get(2) as Y.XmlElement)
    await waitFor(() => typeof stamped.getAttribute("data-block-id") === "string", { what: "the stamped id at the client" })
    expect(api.posts.get("12")!.block_doc!.blocks_order[2]).toBe(stamped.getAttribute("data-block-id"))
  })
})
