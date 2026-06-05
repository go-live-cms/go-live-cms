import { describe, it, expect } from "vitest"
import * as Y from "yjs"

/**
 * Headless convergence harness for the collaborative editor's sync model.
 *
 * It models the client and server as two real Y.Docs plus a "LevelDB" snapshot,
 * and exercises the disconnect → reconnect → server-restart sequences that broke
 * the live editor. It asserts the CRDT-level invariants the real system relies on:
 *   - reconnect/resync never loses or reverts client content
 *   - a server restart that restores from LevelDB converges to the client's content
 *   - a server restart whose snapshot is cleared (the probe-and-clear path) still
 *     recovers because the connected client re-populates the server
 *   - repeated resync ticks (the 2s "heartbeat") are idempotent once converged
 *
 * NOTE: this covers the SYNC + SERVER-RESTORE model headlessly. The editor-binding
 * level (TipTap setContent on reconnect) is guarded by hasInitializedRef in
 * Editor.tsx + the idempotent initialize() covered in BlockPersistenceManager.test,
 * and confirmed end-to-end via the debug instrumentation in Docker.
 */
class CollabHarness {
  client = new Y.Doc()
  server = new Y.Doc()
  private snapshot: Uint8Array | null = null // models the server's LevelDB store

  clientText() {
    return this.client.getText("content").toString()
  }
  serverText() {
    return this.server.getText("content").toString()
  }

  typeOnClient(s: string) {
    const t = this.client.getText("content")
    t.insert(t.length, s)
  }
  typeOnServerPeer(s: string) {
    // a second collaborator, represented directly on the server doc
    const t = this.server.getText("content")
    t.insert(t.length, s)
  }

  /** Bidirectional state-vector sync (syncStep1/2), then persist the server. */
  sync() {
    const svClient = Y.encodeStateVector(this.client)
    const svServer = Y.encodeStateVector(this.server)
    Y.applyUpdate(this.server, Y.encodeStateAsUpdate(this.client, svServer))
    Y.applyUpdate(this.client, Y.encodeStateAsUpdate(this.server, svClient))
    this.persist()
  }

  /** Models the server's incremental LevelDB persistence. */
  private persist() {
    this.snapshot = Y.encodeStateAsUpdate(this.server)
  }

  /**
   * Models a server process restart.
   * - clearedSnapshot=true models the bindState probe-and-clear path (server comes
   *   back with NO restored state and must rebuild from the connected client).
   */
  restartServer({ clearedSnapshot = false } = {}) {
    this.server = new Y.Doc()
    if (this.snapshot && !clearedSnapshot) {
      Y.applyUpdate(this.server, this.snapshot) // LevelDB restore
    }
  }
}

describe("reconnect convergence — offline edits", () => {
  it("edits made while disconnected survive a reconnect/sync", () => {
    const h = new CollabHarness()
    h.typeOnClient("hello ")
    h.sync() // online
    expect(h.serverText()).toBe("hello ")

    // go offline: type without syncing
    h.typeOnClient("world")
    expect(h.serverText()).toBe("hello ") // server hasn't seen it yet

    // reconnect
    h.sync()
    expect(h.clientText()).toBe("hello world")
    expect(h.serverText()).toBe("hello world")
  })
})

describe("reconnect convergence — server restart with LevelDB restore", () => {
  it("restores content and converges with the client", () => {
    const h = new CollabHarness()
    h.typeOnClient("persisted content")
    h.sync() // server persists to LevelDB

    h.restartServer() // restore from LevelDB
    expect(h.serverText()).toBe("persisted content")

    h.sync()
    expect(h.clientText()).toBe("persisted content")
    expect(h.serverText()).toBe("persisted content")
  })

  it("preserves edits typed mid-session, right before the restart", () => {
    const h = new CollabHarness()
    h.typeOnClient("saved.")
    h.sync()

    // user keeps typing; this reaches the server (and LevelDB) via sync
    h.typeOnClient("inflight")
    h.sync()

    h.restartServer()
    h.sync()
    expect(h.clientText()).toBe("saved.inflight")
    expect(h.serverText()).toBe("saved.inflight")
  })

  it("recovers even if the restart comes back with a CLEARED snapshot (probe-and-clear)", () => {
    const h = new CollabHarness()
    h.typeOnClient("important")
    h.sync()

    // server restarts but its persisted state was detected corrupt and cleared,
    // so it comes back empty. The connected client must re-populate it.
    h.restartServer({ clearedSnapshot: true })
    expect(h.serverText()).toBe("") // server is empty right after restart

    h.sync()
    expect(h.clientText()).toBe("important") // client never lost its content
    expect(h.serverText()).toBe("important") // and the server is rebuilt from it
  })
})

describe("reconnect convergence — heartbeat idempotency", () => {
  it("repeated resync ticks do not revert or duplicate content once converged", () => {
    const h = new CollabHarness()
    h.typeOnClient("stable text")
    h.sync()
    h.restartServer()

    // simulate the 2s resync 'heartbeat' firing many times
    for (let i = 0; i < 10; i++) h.sync()

    expect(h.clientText()).toBe("stable text")
    expect(h.serverText()).toBe("stable text")
  })

  it("content length never shrinks across a restart + repeated resyncs", () => {
    const h = new CollabHarness()
    h.typeOnClient("abcdef")
    h.sync()
    const before = h.clientText().length

    h.restartServer({ clearedSnapshot: true })
    for (let i = 0; i < 5; i++) h.sync()

    expect(h.clientText().length).toBeGreaterThanOrEqual(before)
    expect(h.clientText()).toContain("abcdef")
  })
})

describe("reconnect convergence — concurrent collaborators", () => {
  it("merges concurrent edits from two peers (additive CRDT)", () => {
    const h = new CollabHarness()
    h.typeOnClient("A")
    h.sync()

    // both sides edit concurrently before the next sync
    h.typeOnClient("-client")
    h.typeOnServerPeer("-peer")
    h.sync()

    // both edits survive; both docs agree
    expect(h.clientText()).toContain("-client")
    expect(h.clientText()).toContain("-peer")
    expect(h.clientText()).toBe(h.serverText())
  })
})
