// Test helper (not app code): the real Hocuspocus collab server in-process, with the
// #280 API faked in memory (web/collab-server/testkit.ts), and the editor's real client
// (HocuspocusCollaboration) connecting to it over WebSockets. The client-side
// collaboration tests use it as their relay (#206 P3, #283).
//
// Like every in-process test, it can't reproduce the dual yjs instance hazard (one yjs
// for everything); web/collab-server/process.test.ts covers that.
import { verifyTicket } from "../../../collab-server/access"
import { createCollabServer, type CollabServer } from "../../../collab-server/server"
import { FakeClock, FakeCollabApi, ISSUER, ticketKeys, waitFor } from "../../../collab-server/testkit"
import type { BlockDocV1 } from "../blocks-spec"
import { HocuspocusCollaboration } from "./HocuspocusCollaboration"

export { waitFor }

export const POST_ID = 12

/** The server's access re-check interval in the relay; it runs only when a test advances `clock`. */
export const RECHECK_MS = 60_000

export interface Relay {
  api: FakeCollabApi
  /** Drives the server's access re-check (#313): `await relay.clock.advance(RECHECK_MS)`. */
  clock: FakeClock
  server: CollabServer
  url: string
  /** A client as `userId` (1 admin, 2 editor, 3 contributor who doesn't own the post). */
  client(userId: string, options?: { epoch?: string }): HocuspocusCollaboration
  /**
   * Stops the server (storing every doc) and starts a new one on the same port.
   * `whileDown` runs in between (e.g. write block_doc around the server).
   */
  restart(whileDown?: () => void | Promise<void>): Promise<void>
  destroy(): Promise<void>
}

export async function startRelay({ blockDoc = null, revision = 1 }: { blockDoc?: BlockDocV1 | null; revision?: number } = {}): Promise<Relay> {
  const { publicKey, sign } = await ticketKeys()
  const WebSocketPolyfill = await jsdomWebSocket()
  const api = new FakeCollabApi()
  api.users.set("1", { role: "admin" })
  api.users.set("2", { role: "editor" })
  api.users.set("3", { role: "contributor" })
  api.addPost(String(POST_ID), blockDoc, revision)

  const clients: HocuspocusCollaboration[] = []
  const clock = new FakeClock()
  const make = (port = 0) =>
    createCollabServer({
      api,
      verifyTicket: (ticket, docName) => verifyTicket(ticket, publicKey, { issuer: ISSUER, docName }),
      port,
      address: "127.0.0.1",
      debounce: 50,
      maxDebounce: 500,
      storeRetryMs: 50,
      accessRecheck: { intervalMs: RECHECK_MS, jitter: 0, clock },
    })

  let server = make()
  const port = await server.listen()
  const url = `ws://127.0.0.1:${port}`

  const relay: Relay = {
    api,
    clock,
    get server() {
      return server
    },
    url,
    client(userId, { epoch } = {}) {
      const client = new HocuspocusCollaboration(POST_ID, {
        url,
        getTicket: async (docName) => sign({ user_id: userId, doc: docName, iat: new Date().toISOString() }),
        user: { name: `user-${userId}`, color: "#000000", id: Number(userId) },
        authRetryMs: 50,
        WebSocketPolyfill,
        reconnectDelayMs: 50,
      })
      if (epoch) client.socket.configuration.url = `${url}?epoch=${encodeURIComponent(epoch)}`
      clients.push(client)
      return client
    },
    async restart(whileDown) {
      // Hocuspocus's destroy() stores and unloads every doc and sends each client a close
      // message, but leaves the sockets open; the real process then exits, which drops
      // them. Do that here, or the clients never notice the restart.
      const sockets = [...server.server.webSocketServer.clients]
      await server.destroy(2000)
      sockets.forEach((socket) => socket.terminate())
      await whileDown?.()
      server = make(port)
      await server.listen()
    },
    async destroy() {
      clients.forEach((client) => client.destroy())
      await server.destroy(2000)
    },
  }
  return relay
}

// Under the jsdom environment the global Event is jsdom's, and both Node's built-in
// WebSocket and jsdom's (undici underneath) then fail to dispatch theirs ("must be an
// instance of Event"). So there the clients use `ws`, which has its own event classes:
// the copy @hocuspocus/provider itself depends on, not a dependency of ours. Under the
// node environment: the built-in WebSocket, as in a browser.
async function jsdomWebSocket(): Promise<unknown> {
  if (typeof document === "undefined") return undefined
  const { createRequire } = await import("node:module")
  const fromProvider = createRequire(createRequire(import.meta.url).resolve("@hocuspocus/provider"))
  return fromProvider("ws")
}
