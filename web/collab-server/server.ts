// The Hocuspocus collab server (#206 P2): auth (auth.ts), load (load.ts), store
// (store.ts) and the access re-check of open connections (recheck.ts, #313) wired into
// Hocuspocus hooks, plus `flush` for the internal listener.
//
// Built by a factory with every dependency injected, so tests run it in-process
// (server.test.ts) and main.ts runs the same code from the bundle.
import * as Y from "yjs"
import { Server, type Document, type Hocuspocus } from "@hocuspocus/server"
import type { Schema } from "prosemirror-model"
import type { BlockDocV1 } from "../gl-admin/lib/blocks-spec"
import { getCoreSchema } from "../gl-admin/lib/collaboration/schema"
import { isCollabDocName, postIdOf, TicketReplayGuard, type TicketClaims } from "./access"
import type { CollabStoreBody, InternalApi } from "./api"
import { AuthRejection, createAuthenticate, DENY, type CollabContext } from "./auth"
import { loadIntoDoc, readMeta } from "./load"
import { docNameForLog, errorMessage, logEvent } from "./logsafe"
import { createAccessRecheck, type AccessRecheckOptions } from "./recheck"
import { prepareStore } from "./store"

export interface CollabServerOptions {
  api: InternalApi
  verifyTicket(ticket: string, docName: string): Promise<TicketClaims>
  port: number
  address?: string
  /** onStoreDocument debounce (ms). */
  debounce?: number
  maxDebounce?: number
  schema?: Schema
  newEpoch?: () => string
  /** First retry delay after a failed store (doubles up to 60s). */
  storeRetryMs?: number
  /** Interval, jitter, grace period and clock of the access re-check (recheck.ts). */
  accessRecheck?: Omit<AccessRecheckOptions, "fetchAccess">
}

/** Sent to every client of a doc with broadcastStateless after each store attempt. */
export type StoreMessage =
  | { type: "stored"; revision: number | null; block_doc: "written" | "kept-invalid" | "kept-empty" | "unchanged" }
  | { type: "store_failed" }

export type StoreResult = { ok: true; skipped: boolean } | { ok: false; error: string }

interface Session {
  postId: string
  previous: BlockDocV1 | null
  revision: number | null
  clientEdited: boolean
  lastEditorId: string | null
  /** Snapshot of the doc as last stored; equal → nothing to store. */
  storedSnapshot: Y.Snapshot | null
  failed: boolean
  retryTimer: NodeJS.Timeout | null
  retryDelay: number
}

/** onLoadDocument for a post the API doesn't have (404). */
class PostNotFoundError extends Error {
  constructor() {
    super("post not found")
    this.name = "PostNotFoundError"
  }
}

/**
 * Every store says which block_revision its state was derived from. The API requires it
 * on a state-only store (a seed, an invalid or unchanged block_doc) and refuses any store
 * whose base is behind, so a state can't be recorded against a block_doc it never saw.
 */
function withBaseRevision(body: CollabStoreBody, session: Pick<Session, "revision">): CollabStoreBody {
  if (session.revision !== null && session.revision > 0) body.base_revision = session.revision
  return body
}

const contextOf = (value: unknown): Partial<CollabContext> =>
  value && typeof value === "object" ? (value as Partial<CollabContext>) : {}

export function createCollabServer(options: CollabServerOptions) {
  const {
    api,
    port,
    address = "0.0.0.0",
    debounce = 2000,
    maxDebounce = 10_000,
    schema = getCoreSchema(),
    newEpoch,
    storeRetryMs = 2000,
  } = options
  const sessions = new Map<string, Session>()
  const replayGuard = new TicketReplayGuard()
  const recheck = createAccessRecheck({
    ...options.accessRecheck,
    fetchAccess: (identity, docName, { requestId }) => api.fetchAccess(identity, docName, { requestId }),
  })
  let hocuspocus: Hocuspocus

  /** The loaded (or loading) document, without loading it. */
  const loadedDocument = async (docName: string): Promise<Document | null> => {
    const loading = hocuspocus.loadingDocuments.get(docName)
    if (loading) return loading.catch(() => null)
    return hocuspocus.documents.get(docName) ?? null
  }

  /** Unloads a doc nobody is connected to (e.g. loaded only for an epoch check that failed). */
  const unloadIfIdle = async (docName: string) => {
    const document = hocuspocus.documents.get(docName)
    if (document && document.getConnectionsCount() === 0) await hocuspocus.unloadDocument(document)
  }

  const authenticate = createAuthenticate({
    verifyTicket: options.verifyTicket,
    consumeTicket: (claims) => replayGuard.consume(claims),
    fetchAccess: (identity, docName, { requestId }) => api.fetchAccess(identity, docName, { requestId }),
    async currentEpoch(docName, { requestId }) {
      // Load it (or join the load in progress), so the epoch compared is the one the
      // connection will get: a load that reseeds makes a new epoch.
      try {
        const document = await hocuspocus.createDocument(
          docName,
          {},
          `epoch-check-${requestId}`,
          { readOnly: true, isAuthenticated: true },
          { requestId },
        )
        return readMeta(document).epoch
      } catch (error) {
        // A deleted post is a final answer, not an outage the client should retry.
        if (error instanceof PostNotFoundError) throw new AuthRejection(DENY.forbidden, "Post not found")
        throw error
      }
    },
  })

  const broadcast = (document: Document, message: StoreMessage) => {
    try {
      document.broadcastStateless(JSON.stringify(message))
    } catch {
      // A doc being destroyed has no one to tell.
    }
  }

  // Runs one store of a loaded doc. Never throws: Hocuspocus calls onStoreDocument from
  // an un-awaited debounce, where a rejection would be unhandled. Callers serialize it
  // with document.saveMutex (Hocuspocus does for onStoreDocument; flush does too).
  async function storeDocument(docName: string, document: Document, trigger: string): Promise<StoreResult> {
    const session = sessions.get(docName)
    if (!session) return { ok: true, skipped: true }
    const before = Y.snapshot(document)
    if (session.storedSnapshot && Y.equalSnapshots(before, session.storedSnapshot) && !session.failed) {
      return { ok: true, skipped: true }
    }

    const doc = docNameForLog(docName)
    let prepared: ReturnType<typeof prepareStore>
    try {
      prepared = prepareStore(document, schema, session)
    } catch (error) {
      return storeFailed(docName, document, session, trigger, error)
    }
    const { body, decision, unconvertible, stamped } = prepared
    withBaseRevision(body, session)
    // What `body.state` holds (prepareStore encodes it synchronously). Taken before the
    // PUT: edits that arrive while it's in flight must not count as stored.
    const storing = Y.snapshot(document)
    for (const block of unconvertible) {
      logEvent("warn", "collab_store_unconvertible", {
        doc,
        block_id: block.id ?? undefined,
        type: block.type,
        error: errorMessage(block.error),
      })
    }
    if (!decision.write && decision.reason === "invalid") {
      logEvent("error", "collab_store_invalid", { doc, error: decision.error })
    }
    if (!decision.write && decision.reason === "empty-without-edit") {
      logEvent("warn", "collab_store_empty_skipped", { doc })
    }

    try {
      const result = await api.putCollab(session.postId, body)
      if (decision.write) session.previous = decision.blockDoc
      if (result.block_revision !== null) session.revision = result.block_revision
      session.storedSnapshot = storing
      session.failed = false
      session.retryDelay = storeRetryMs
      if (session.retryTimer) clearTimeout(session.retryTimer)
      session.retryTimer = null
      const kept = decision.write
        ? "written"
        : decision.reason === "invalid"
          ? "kept-invalid"
          : decision.reason === "empty-without-edit"
            ? "kept-empty"
            : "unchanged"
      logEvent("info", "collab_store", {
        doc,
        trigger,
        block_doc: kept,
        revision: session.revision,
        stamped_ids: stamped || undefined,
        bytes: body.state.length,
      })
      broadcast(document, { type: "stored", revision: session.revision, block_doc: kept })
      return { ok: true, skipped: false }
    } catch (error) {
      return storeFailed(docName, document, session, trigger, error)
    }
  }

  function storeFailed(docName: string, document: Document, session: Session, trigger: string, error: unknown): StoreResult {
    session.failed = true
    logEvent("error", "collab_store_failed", {
      doc: docNameForLog(docName),
      trigger,
      error: errorMessage(error),
      retry_ms: session.retryDelay,
    })
    broadcast(document, { type: "store_failed" })
    // Keep retrying while the doc is in memory: it's the only copy of these edits.
    // beforeUnloadDocument refuses to unload a doc whose last store failed.
    if (!session.retryTimer) {
      const delay = session.retryDelay
      session.retryDelay = Math.min(delay * 2, 60_000)
      session.retryTimer = setTimeout(() => {
        session.retryTimer = null
        if (hocuspocus.documents.get(docName) !== document) return
        void document.saveMutex
          .runExclusive(() => storeDocument(docName, document, "retry"))
          .then((result) => {
            if (result.ok) void hocuspocus.unloadDocument(document)
          })
      }, delay)
      session.retryTimer.unref?.()
    }
    return { ok: false, error: errorMessage(error) }
  }

  const server = new Server({
    port,
    address,
    quiet: true,
    // main.ts handles signals (destroy with a timeout, then exit).
    stopOnSignals: false,
    debounce,
    maxDebounce,
    async onAuthenticate(payload) {
      try {
        const context = await authenticate(payload)
        return { ...context, connectedAt: Date.now() }
      } catch (error) {
        await unloadIfIdle(payload.documentName).catch(() => {})
        throw error
      }
    },

    async onLoadDocument({ document, documentName, context }) {
      if (!isCollabDocName(documentName)) throw new Error("invalid document name")
      const postId = postIdOf(documentName)
      const requestId = contextOf(context).requestId
      const doc = docNameForLog(documentName)
      let record
      try {
        record = await api.getCollab(postId, { requestId })
      } catch (error) {
        logEvent("error", "collab_load_failed", { request_id: requestId, doc, error: errorMessage(error) })
        throw error
      }
      if (!record) {
        logEvent("warn", "collab_load_failed", { request_id: requestId, doc, error: "post not found" })
        throw new PostNotFoundError()
      }
      const outcome = loadIntoDoc(document, record, schema, newEpoch)
      const session: Session = {
        postId,
        previous: record.block_doc,
        revision: record.block_revision,
        clientEdited: false,
        lastEditorId: null,
        storedSnapshot: outcome.kind === "restored" ? Y.snapshot(document) : null,
        failed: false,
        retryTimer: null,
        retryDelay: storeRetryMs,
      }
      sessions.set(documentName, session)
      logEvent(outcome.kind === "seeded" && outcome.reason === "revision-mismatch" ? "warn" : "info", "collab_load", {
        request_id: requestId,
        doc,
        outcome: outcome.kind,
        reason: outcome.kind === "seeded" ? outcome.reason : undefined,
        dropped_blocks: outcome.kind === "seeded" ? outcome.dropped : undefined,
        revision: record.block_revision,
      })

      // Persist a seed right away (Yjs state and epoch only; block_doc is what it was
      // seeded from), so a reload or restart restores this epoch instead of reseeding.
      if (outcome.kind === "seeded") {
        try {
          const { epoch } = readMeta(document)
          await api.putCollab(
            postId,
            withBaseRevision(
              { state: Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64"), epoch: epoch as string },
              session,
            ),
            { requestId },
          )
          session.storedSnapshot = Y.snapshot(document)
        } catch (error) {
          // Retried like any failed store, and the doc isn't unloaded until it lands:
          // otherwise the next load reseeds with yet another epoch and every client
          // holding this one is refused (stale-epoch).
          storeFailed(documentName, document, session, "seed", error)
        }
      }
    },

    async onChange({ documentName, context }) {
      const session = sessions.get(documentName)
      const { userId } = contextOf(context)
      // Only client connections carry a userId; the server's own writes (seeding, id
      // stamping) don't count as edits.
      if (session && userId) {
        session.clientEdited = true
        session.lastEditorId = userId
      }
    },

    async onStoreDocument({ document, documentName }) {
      await storeDocument(documentName, document, "debounce")
    },

    async beforeUnloadDocument({ documentName }) {
      if (sessions.get(documentName)?.failed) {
        throw new Error("last store failed; keeping the document in memory")
      }
    },

    async afterUnloadDocument({ documentName }) {
      const session = sessions.get(documentName)
      if (session?.retryTimer) clearTimeout(session.retryTimer)
      sessions.delete(documentName)
    },

    async connected({ documentName, context, connection }) {
      const ctx = contextOf(context)
      // Hocuspocus runs this hook after the connection exists and its queued messages ran;
      // one closed in between would never fire the onClose below and stay re-checked forever.
      if (ctx.userId && typeof ctx.issuedAt === "number" && connection.document.hasConnection(connection)) {
        recheck.add(connection, { userId: ctx.userId, issuedAt: ctx.issuedAt, docName: documentName })
        connection.onClose(() => recheck.remove(connection))
      }
      logEvent("info", "ws_connect", {
        request_id: ctx.requestId,
        doc: docNameForLog(documentName),
        user_id: ctx.userId,
        role: ctx.role,
        read_only: connection.readOnly,
        live_connections: hocuspocus.getConnectionsCount(),
      })
    },

    async onDisconnect({ documentName, context }) {
      const ctx = contextOf(context) as Partial<CollabContext> & { connectedAt?: number }
      logEvent("info", "ws_close", {
        request_id: ctx.requestId,
        doc: docNameForLog(documentName),
        user_id: ctx.userId,
        duration_ms: ctx.connectedAt ? Date.now() - ctx.connectedAt : undefined,
        live_connections: hocuspocus.getConnectionsCount(),
      })
    },
  })
  hocuspocus = server.hocuspocus

  /**
   * Stores a doc now and waits for it (publish calls this before reading block_doc).
   * A doc that isn't loaded has nothing unsaved: ok. Fails if the store fails.
   */
  async function flush(docName: string): Promise<StoreResult & { loaded: boolean }> {
    const document = await loadedDocument(docName)
    if (!document) return { ok: true, skipped: true, loaded: false }
    const result = await document.saveMutex.runExclusive(() => storeDocument(docName, document, "flush"))
    return { ...result, loaded: true }
  }

  return {
    server,
    get hocuspocus() {
      return hocuspocus
    },
    flush,
    /** Open connections the access re-check is tracking. */
    get recheckedConnections(): number {
      return recheck.size
    },
    async listen(): Promise<number> {
      await server.listen()
      const addr = server.httpServer.address()
      return typeof addr === "object" && addr ? addr.port : port
    },
    /**
     * Closes every connection, which stores each doc with unsaved changes, then stops.
     * Waits at most `timeoutMs`: Hocuspocus waits for every doc to unload, and a doc
     * whose store keeps failing never does.
     */
    async destroy(timeoutMs = 10_000) {
      recheck.stop()
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        server.destroy(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        }),
      ])
      clearTimeout(timer)
      for (const session of sessions.values()) if (session.retryTimer) clearTimeout(session.retryTimer)
    },
  }
}

export type CollabServer = ReturnType<typeof createCollabServer>
