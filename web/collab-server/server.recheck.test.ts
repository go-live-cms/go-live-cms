// The access re-check (#313) in the real server: in-process Hocuspocus, real
// HocuspocusProviders over WebSockets, the #280 API in memory (FakeCollabApi) and a
// manual clock for the re-check timer (Hocuspocus's own timers stay real).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { canonical } from "../gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { verifyTicket } from "./access"
import { ACCESS_REVOKED } from "./recheck"
import { createCollabServer, type CollabServer } from "./server"
import {
  appendParagraph,
  connect,
  FakeClock,
  FakeCollabApi,
  ISSUER,
  paragraphDoc,
  paragraphs,
  ticketKeys,
  waitFor,
  type Client,
} from "./testkit"

const { publicKey, sign } = await ticketKeys()
const DOC = "post-12"
const MINUTE = 60_000

let api: FakeCollabApi
let clock: FakeClock
let collab: CollabServer
let url: string
let clients: Client[]

function open(userId: string) {
  const client = connect(url, DOC, () => sign({ user_id: userId, doc: DOC, iat: new Date().toISOString() }))
  clients.push(client)
  return client
}

async function synced(client: Client) {
  const outcome = await client.outcome
  if (!outcome.synced) throw new Error(`denied: ${outcome.reason}`)
  return outcome
}

const serverDoc = () => collab.hocuspocus.documents.get(DOC)!

beforeEach(async () => {
  api = new FakeCollabApi()
  api.users.set("1", { role: "admin" })
  api.users.set("2", { role: "editor" })
  api.addPost("12", canonical(paragraphDoc("one")), 5)
  clock = new FakeClock()
  clients = []
  collab = createCollabServer({
    api,
    verifyTicket: (ticket, docName) => verifyTicket(ticket, publicKey, { issuer: ISSUER, docName }),
    port: 0,
    address: "127.0.0.1",
    debounce: 50,
    maxDebounce: 500,
    storeRetryMs: 50,
    accessRecheck: { intervalMs: MINUTE, jitter: 0, retryMs: 10_000, graceMs: 2 * MINUTE, clock },
  })
  url = `ws://127.0.0.1:${await collab.listen()}`
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(async () => {
  clients.forEach((client) => client.destroy())
  await collab.destroy(2000)
  vi.restoreAllMocks()
})

describe("access re-check of open connections (#313)", () => {
  it("a demoted editor becomes read-only within one interval, and their later edits are dropped", async () => {
    const admin = open("1")
    const editor = open("2")
    await synced(admin)
    await synced(editor)
    await waitFor(() => collab.recheckedConnections === 2, { what: "both connections tracked" })

    appendParagraph(editor.doc, "before", "blk-before-00001")
    await waitFor(() => paragraphs(serverDoc()).includes("before"), { what: "the edit before the demotion" })

    api.users.set("2", { role: "contributor" })
    await clock.advance(MINUTE)
    await waitFor(() => editor.stateless.some((m) => (m as { type: string }).type === "access"), { what: "the access message" })
    expect(editor.stateless).toContainEqual({ type: "access", mode: "read", reason: "demoted" })
    expect(admin.stateless.some((m) => (m as { type: string }).type === "access")).toBe(false)

    appendParagraph(editor.doc, "after", "blk-after-000001")
    appendParagraph(admin.doc, "admin", "blk-admin-000001")
    await waitFor(() => paragraphs(serverDoc()).includes("admin"), { what: "the admin's edit" })
    // Give the editor's update time to arrive; it must not be applied.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(paragraphs(serverDoc())).not.toContain("after")
    expect(paragraphs(admin.doc)).not.toContain("after")
    await waitFor(() => (api.posts.get("12")!.block_doc?.blocks_order ?? []).includes("blk-admin-000001"), { what: "the store" })
    expect(api.posts.get("12")!.block_doc!.blocks_order).not.toContain("blk-after-000001")
    // Still connected, as a live read-only view.
    expect(editor.closes).toEqual([])
  })

  it("closes a deleted user's session with access-revoked", async () => {
    const editor = open("2")
    await synced(editor)
    await waitFor(() => collab.recheckedConnections === 1, { what: "the connection tracked" })
    api.users.delete("2")
    await clock.advance(MINUTE)
    await waitFor(() => editor.closes.includes(ACCESS_REVOKED), { what: "the close" })
    expect(collab.recheckedConnections).toBe(0)
    await waitFor(() => serverDoc()?.getConnectionsCount() !== 1, { what: "the server to drop the connection" })
  })

  it("closes a session opened before a password change", async () => {
    const editor = open("2")
    await synced(editor)
    await waitFor(() => collab.recheckedConnections === 1, { what: "the connection tracked" })
    api.passwordChangedAt.set("2", Math.floor(Date.now() / 1000) + 1)
    await clock.advance(MINUTE)
    await waitFor(() => editor.closes.includes(ACCESS_REVOKED), { what: "the close" })

    // A session opened after the change is unaffected.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const fresh = open("2")
    await synced(fresh)
    await waitFor(() => collab.recheckedConnections === 1, { what: "the new connection tracked" })
    await clock.advance(MINUTE)
    expect(fresh.closes).toEqual([])
    expect(fresh.stateless.some((m) => (m as { type: string }).type === "access")).toBe(false)
  })

  it("an API outage doesn't disconnect anyone within the grace period", async () => {
    const admin = open("1")
    const editor = open("2")
    await synced(admin)
    await synced(editor)
    await waitFor(() => collab.recheckedConnections === 2, { what: "both connections tracked" })

    // Last confirmed at connect (t=0); still writable 10s before the grace period ends.
    api.failAccess = true
    await clock.advance(2 * MINUTE - 10_000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(admin.closes).toEqual([])
    expect(editor.closes).toEqual([])
    expect(editor.stateless.some((m) => (m as { type: string }).type === "access")).toBe(false)
    appendParagraph(editor.doc, "during the outage", "blk-outage-00001")
    await waitFor(() => paragraphs(serverDoc()).includes("during the outage"), { what: "edits still accepted" })

    api.failAccess = false
    await clock.advance(10_000)
    expect(collab.recheckedConnections).toBe(2)
    expect(editor.closes).toEqual([])
  })
})
