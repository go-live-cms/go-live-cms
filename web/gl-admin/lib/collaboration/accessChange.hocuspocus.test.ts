import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { appendParagraph, paragraphs } from "../../../collab-server/testkit"
import { RECHECK_MS, startRelay, waitFor, type Relay } from "./hocuspocusRelay.testkit"
import type { CollabAccess } from "./HocuspocusCollaboration"

// The client side of the server's access re-check (#313), against the real collab server
// in-process: a demotion makes the connection read-only (and back), a revoke ends the
// session for good. The local Y.Doc is kept either way.

let relay: Relay

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

async function connected(userId: string) {
  const client = relay.client(userId)
  const changes: CollabAccess[] = []
  client.onAccess((access) => changes.push(access))
  await client.whenSynced()
  await waitFor(() => relay.server.recheckedConnections > 0, { what: "the server to track the connection" })
  return { client, changes }
}

describe("access changes while connected (#313)", () => {
  it("a demotion makes the client read-only and keeps its doc; a promotion makes it writable again", async () => {
    const { client, changes } = await connected("2")
    appendParagraph(client.doc, "mine", "blk-mine-0000001")
    expect(client.readOnly).toBe(false)

    relay.api.users.set("2", { role: "contributor" })
    await relay.clock.advance(RECHECK_MS)
    await waitFor(() => changes.length === 1, { what: "the downgrade" })
    expect(changes[0]).toEqual({ readOnly: true, reason: "demoted", revoked: false })
    expect(client.readOnly).toBe(true)
    expect(client.getStatus()).toBe("connected")
    expect(paragraphs(client.doc)).toContain("mine")

    relay.api.users.set("2", { role: "editor" })
    await relay.clock.advance(RECHECK_MS)
    await waitFor(() => changes.length === 2, { what: "the promotion" })
    expect(changes[1]).toEqual({ readOnly: false, reason: "restored", revoked: false })
    expect(client.readOnly).toBe(false)
  })

  it("after a promotion, resends what the server dropped while read-only, so later edits are stored", async () => {
    const { client, changes } = await connected("2")
    // The resync reconnects this (only) client, so the server may unload and reload the doc.
    const serverParagraphs = () => {
      const doc = relay.server.hocuspocus.documents.get("post-12")
      return doc ? paragraphs(doc) : []
    }
    relay.api.users.set("2", { role: "contributor" })
    await relay.clock.advance(RECHECK_MS)
    await waitFor(() => client.readOnly, { what: "the downgrade" })

    // Typed before the editor turned view-only: the server drops it.
    appendParagraph(client.doc, "typed late", "blk-late-0000001")
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(serverParagraphs()).not.toContain("typed late")
    expect(client.provider.hasUnsyncedChanges).toBe(true)

    relay.api.users.set("2", { role: "editor" })
    await relay.clock.advance(RECHECK_MS)
    await waitFor(() => changes.some((c) => !c.readOnly), { what: "the promotion" })
    appendParagraph(client.doc, "after promotion", "blk-after-promo1")
    // Without the resync, "after promotion" depends on the dropped update and waits on the
    // server forever (never stored).
    await waitFor(() => serverParagraphs().includes("after promotion"), { what: "the later edit on the server" })
    expect(serverParagraphs()).toContain("typed late")
    await waitFor(() => !client.provider.hasUnsyncedChanges, { what: "every edit acknowledged" })
  })

  it("a reconnect takes the access the server grants then, not the earlier message", async () => {
    const { client, changes } = await connected("2")
    relay.api.users.set("2", { role: "contributor" })
    await relay.clock.advance(RECHECK_MS)
    await waitFor(() => client.readOnly, { what: "the downgrade" })

    relay.api.users.set("2", { role: "editor" })
    await relay.restart()
    await waitFor(() => changes.length === 2, { what: "the reconnect's access" })
    expect(changes[1]).toEqual({ readOnly: false, reason: null, revoked: false })
    expect(client.readOnly).toBe(false)
  })

  it("a revoked session (user deleted) ends: read-only, status revoked, never reconnects, doc kept", async () => {
    const { client, changes } = await connected("2")
    appendParagraph(client.doc, "kept locally", "blk-kept-0000001")
    await waitFor(() => paragraphs(relay.server.hocuspocus.documents.get("post-12")!).includes("kept locally"), {
      what: "the edit on the server",
    })

    relay.api.users.delete("2")
    await relay.clock.advance(RECHECK_MS)
    await waitFor(() => changes.length === 1, { what: "the revoke" })
    expect(changes[0]).toEqual({ readOnly: true, reason: null, revoked: true })
    expect(client.revoked).toBe(true)
    expect(client.getStatus()).toBe("revoked")
    expect(paragraphs(client.doc)).toContain("kept locally")

    // No reconnect, even though the socket's own retry would normally kick in.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(relay.server.hocuspocus.getConnectionsCount()).toBe(0)
    expect(client.getStatus()).toBe("revoked")
  })

  it("a password change after connect ends the session", async () => {
    const { client } = await connected("2")
    relay.api.passwordChangedAt.set("2", Math.floor(Date.now() / 1000) + 1)
    await relay.clock.advance(RECHECK_MS)
    await waitFor(() => client.revoked, { what: "the revoke" })
    expect(client.readOnly).toBe(true)
  })
})
