// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { appendParagraph, paragraphDoc, paragraphs } from "../../../collab-server/testkit"
import { canonical } from "./fragmentBridge.fixtures"
import { CollabSaveStatus } from "./CollabSaveStatus"
import { acquireHocuspocus, releaseHocuspocus, type HocuspocusCollaboration } from "./HocuspocusCollaboration"
import { startRelay, waitFor, type Relay } from "./hocuspocusRelay.testkit"

// The convergence harness of reconnect.test.ts, on the Hocuspocus path (#206 P3, #283):
// the real collab server in-process and two real clients (HocuspocusCollaboration, the
// editor's provider) over WebSockets. Unlike the y-websocket model, the server owns
// seeding and storing; these pin what the client relies on:
//   - two providers converge, both ways;
//   - the client never seeds or writes on sync (the server seeded);
//   - a server restart (state stored, reloaded) loses and duplicates nothing, including
//     edits made while it was down;
//   - a reseeded doc (block_doc written around the server) refuses the old epoch, the
//     client goes stale, and a fresh client sees the new content once;
//   - a read-only peer (contributor) gets live updates and its own updates are ignored.

let relay: Relay

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  relay = await startRelay({ blockDoc: canonical(paragraphDoc("one", "two")), revision: 3 })
})

afterEach(async () => {
  await relay.destroy()
  vi.restoreAllMocks()
})

const stored = () => relay.api.posts.get("12")!
const storedText = () => stored().block_doc!.blocks_order.map((id) => (stored().block_doc!.blocks[id].attrs as { text?: string }).text)

/** Updates the client made to its own doc (not received from the server). */
function localUpdates(client: HocuspocusCollaboration) {
  const counter = { count: 0 }
  client.doc.on("update", (_u: Uint8Array, origin: unknown) => {
    if (origin !== client.provider) counter.count++
  })
  return counter
}

describe("Hocuspocus client: reconnect and convergence", () => {
  it("two providers converge both ways; the client never seeds", async () => {
    const a = relay.client("1")
    const b = relay.client("2")
    const aLocal = localUpdates(a)
    const bLocal = localUpdates(b)
    await Promise.all([a.whenSynced(), b.whenSynced()])

    // The server seeded from block_doc; the clients wrote nothing on sync.
    expect(paragraphs(a.doc)).toEqual(["one", "two"])
    expect(paragraphs(b.doc)).toEqual(["one", "two"])
    expect(aLocal.count).toBe(0)
    expect(bLocal.count).toBe(0)
    expect(a.getEpoch()).toBe(stored().epoch)

    appendParagraph(a.doc, "from a", "blk-from-a-0001")
    appendParagraph(b.doc, "from b", "blk-from-b-0001")
    await waitFor(() => paragraphs(a.doc).length === 4 && paragraphs(b.doc).length === 4, { what: "convergence" })
    expect(paragraphs(a.doc)).toEqual(paragraphs(b.doc))
    await waitFor(() => stored().block_doc!.blocks_order.length === 4, { what: "the store" })
  })

  it("a server restart mid-edit loses and duplicates nothing", async () => {
    const a = relay.client("1")
    const b = relay.client("2")
    await Promise.all([a.whenSynced(), b.whenSynced()])
    appendParagraph(a.doc, "before restart", "blk-before-0001")
    await waitFor(() => paragraphs(b.doc).includes("before restart"), { what: "b to see it" })

    await relay.restart(() => {
      // Typed while the server is down: queued, sent on reconnect.
      appendParagraph(a.doc, "while down", "blk-while-down1")
    })
    await waitFor(() => a.synced && b.synced, { what: "both to resync" })
    await waitFor(() => paragraphs(b.doc).includes("while down"), { what: "the offline edit to arrive" })

    const expected = ["one", "two", "before restart", "while down"]
    expect(paragraphs(a.doc)).toEqual(expected)
    expect(paragraphs(b.doc)).toEqual(expected)
    // Reconnected with its epoch, the same seeding: not stale.
    expect(a.stale).toBe(false)
    await waitFor(() => storedText().length === 4, { what: "the store" })
    expect(storedText()).toEqual(expected)
  })

  it("block_doc written around the server → stale epoch → the client is dropped, a fresh one sees the new doc once", async () => {
    const a = relay.client("1")
    await a.whenSynced()
    const oldEpoch = a.getEpoch()
    const onStale = vi.fn()
    a.onStale(onStale)

    await relay.restart(() => {
      relay.api.writeAround("12", canonical(paragraphDoc("restored by an admin tool")))
    })
    await waitFor(() => onStale.mock.calls.length === 1, { what: "stale-epoch" })
    expect(a.stale).toBe(true)
    expect(a.destroyed).toBe(true)

    const fresh = relay.client("1")
    await fresh.whenSynced()
    expect(paragraphs(fresh.doc)).toEqual(["restored by an admin tool"])
    expect(fresh.getEpoch()).not.toBe(oldEpoch)
  })

  it("the registry never hands out a stale connection", async () => {
    const first = acquireHocuspocus(12, () => relay.client("1"))
    expect(acquireHocuspocus(12, () => relay.client("1"))).toBe(first)
    await first.whenSynced()
    await relay.restart(() => {
      relay.api.writeAround("12", canonical(paragraphDoc("reseeded")))
    })
    await waitFor(() => first.stale, { what: "stale" })
    const next = acquireHocuspocus(12, () => relay.client("1"))
    expect(next).not.toBe(first)
    await next.whenSynced()
    expect(paragraphs(next.doc)).toEqual(["reseeded"])
    releaseHocuspocus(first)
    releaseHocuspocus(first)
    releaseHocuspocus(next)
  })

  it("a read-only peer gets live updates; its own updates are ignored", async () => {
    const editor = relay.client("1")
    const contributor = relay.client("3")
    await Promise.all([editor.whenSynced(), contributor.whenSynced()])
    expect(contributor.readOnly).toBe(true)
    expect(editor.readOnly).toBe(false)

    appendParagraph(contributor.doc, "should not land", "blk-readonly-001")
    appendParagraph(editor.doc, "live", "blk-live-000001")
    await waitFor(() => paragraphs(contributor.doc).includes("live"), { what: "the live edit" })
    await waitFor(() => storedText().includes("live"), { what: "the store" })
    expect(paragraphs(editor.doc)).not.toContain("should not land")
    expect(storedText()).not.toContain("should not land")
  })

  it("reports Saving → Saved from the server's store messages, and waitForStored includes earlier edits", async () => {
    const a = relay.client("1")
    await a.whenSynced()
    const status = new CollabSaveStatus(a)
    const states: (string | null)[] = []
    status.subscribe(({ state }) => states.push(state))

    appendParagraph(a.doc, "typed", "blk-typed-000001")
    expect(status.getState()).toBe("saving")
    const message = await status.waitForStored()
    expect(message.block_doc).toBe("written")
    expect(storedText()).toContain("typed")
    await waitFor(() => status.getState() === "saved", { what: "saved" })
    expect(states[0]).toBe("saving")
    // Nothing pending: settled() doesn't wait.
    await status.settled({ timeoutMs: 1 })
    status.destroy()
  })

  it("a remote edit doesn't make this client 'saving'", async () => {
    const a = relay.client("1")
    const b = relay.client("2")
    await Promise.all([a.whenSynced(), b.whenSynced()])
    const status = new CollabSaveStatus(b)
    appendParagraph(a.doc, "from a", "blk-from-a-0002")
    await waitFor(() => paragraphs(b.doc).includes("from a"), { what: "b to see it" })
    expect(status.getState()).not.toBe("saving")
    expect(status.hasPendingEdits()).toBe(false)
    status.destroy()
  })
})

describe("urlWithEpoch", () => {
  it("adds or replaces the epoch parameter", async () => {
    const { urlWithEpoch } = await import("./HocuspocusCollaboration")
    expect(urlWithEpoch("ws://h:1235", "e1")).toBe("ws://h:1235?epoch=e1")
    expect(urlWithEpoch("ws://h:1235?epoch=e1", "e2")).toBe("ws://h:1235?epoch=e2")
    expect(urlWithEpoch("wss://h/collab?x=1", null)).toBe("wss://h/collab?x=1")
  })
})

