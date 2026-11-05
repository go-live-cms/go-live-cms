import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { appendParagraph, paragraphs } from "../../../collab-server/testkit"
import { POST_ID, startRelay, waitFor, type Relay } from "./hocuspocusRelay.testkit"
import type { CollabAccess } from "./HocuspocusCollaboration"

// Edit access grants (#321) on an open connection, against the real collab server
// in-process. The API answers the access lookup with can_edit from its grants and, after a
// grant or a revoke, asks the server to re-check that user's connections now (POST
// /internal/users/:id/recheck → checkUser). Nothing else changes in the sync: it is the
// #313 re-check's promotion and demotion.

let relay: Relay
// User 3 is a contributor who doesn't own the post (relay testkit): read-only by default.
const CONTRIBUTOR = "3"
const DOC = `post-${POST_ID}`

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  relay = await startRelay()
})

afterEach(async () => {
  await relay.destroy()
  vi.restoreAllMocks()
})

const serverParagraphs = () => {
  const doc = relay.server.hocuspocus.documents.get(DOC)
  return doc ? paragraphs(doc) : []
}

// The last stored block_doc (the last PUT that wrote one), as JSON text.
const stored = () => JSON.stringify([...relay.api.puts].reverse().find((put) => put.body.block_doc)?.body.block_doc ?? null)

async function connected(userId: string) {
  const client = relay.client(userId)
  const changes: CollabAccess[] = []
  client.onAccess((access) => changes.push(access))
  await client.whenSynced()
  await waitFor(() => relay.server.recheckedConnections > 0, { what: "the server to track the connection" })
  return { client, changes }
}

// What the API does after it commits a grant or a revoke.
async function apiRechecks(userId: string) {
  expect(relay.server.recheckUser(userId)).toBe(1)
  await relay.clock.advance(1)
}

describe("edit access grants on an open connection (#321)", () => {
  it("a granted contributor's view-only connection turns writable at once, and their edits are stored", async () => {
    const { client, changes } = await connected(CONTRIBUTOR)
    expect(client.readOnly).toBe(true)

    relay.api.grants.add(`${CONTRIBUTOR}:${POST_ID}`)
    await apiRechecks(CONTRIBUTOR)
    await waitFor(() => !client.readOnly, { what: "the upgrade" })
    expect(changes.at(-1)).toEqual({ readOnly: false, reason: "restored", revoked: false })
    // A promotion may reconnect (if the server dropped anything sent while read-only,
    // HocuspocusCollaboration resyncs), so wait for the connection, not just the mode.
    await waitFor(() => client.getStatus() === "connected", { what: "the connection after the upgrade" })

    appendParagraph(client.doc, "granted edit", "blk-granted-0001")
    await waitFor(() => serverParagraphs().includes("granted edit"), { what: "the edit on the server" })
    await relay.server.flush(DOC)
    expect(stored()).toContain("granted edit")
    await waitFor(() => !client.provider.hasUnsyncedChanges, { what: "the edit acknowledged" })
  })

  it("a revoked grant drops the open connection to read-only: later edits are dropped, the session stays", async () => {
    relay.api.grants.add(`${CONTRIBUTOR}:${POST_ID}`)
    const { client, changes } = await connected(CONTRIBUTOR)
    expect(client.readOnly).toBe(false)
    appendParagraph(client.doc, "before revoke", "blk-before-00001")
    await waitFor(() => serverParagraphs().includes("before revoke"), { what: "the edit on the server" })

    relay.api.grants.delete(`${CONTRIBUTOR}:${POST_ID}`)
    await apiRechecks(CONTRIBUTOR)
    await waitFor(() => client.readOnly, { what: "the downgrade" })
    expect(changes.at(-1)).toEqual({ readOnly: true, reason: "demoted", revoked: false })
    expect(client.getStatus()).toBe("connected")
    expect(client.revoked).toBe(false)

    appendParagraph(client.doc, "after revoke", "blk-after-000001")
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(serverParagraphs()).not.toContain("after revoke")
    await relay.server.flush(DOC)
    expect(stored()).toContain("before revoke")
    expect(stored()).not.toContain("after revoke")
    // Still watching live: someone else's edit reaches it.
    const editor = relay.client("2")
    await editor.whenSynced()
    appendParagraph(editor.doc, "from the editor", "blk-editor-00001")
    await waitFor(() => paragraphs(client.doc).includes("from the editor"), { what: "the live view" })
  })

  it("a grant on another post changes nothing here", async () => {
    const { client } = await connected(CONTRIBUTOR)
    relay.api.grants.add(`${CONTRIBUTOR}:999`)
    await apiRechecks(CONTRIBUTOR)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.readOnly).toBe(true)
  })
})
