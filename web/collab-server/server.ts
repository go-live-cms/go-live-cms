// The Hocuspocus collab server (#206 P2): auth (auth.ts), load (load.ts), store
// (store.ts) and the access re-check of open connections (recheck.ts, #313) wired into
// Hocuspocus hooks, plus `flush` for the internal listener.
//
// Built by a factory with every dependency injected, so tests run it in-process
// (server.test.ts) and main.ts runs the same code from the bundle.
import * as Y from "yjs"
import { Server, type Document, type Hocuspocus } from "@hocuspocus/server"
import type { Schema } from "prosemirror-model"
import type { BlockDocKind, BlockDocV1 } from "../gl-admin/lib/blocks-spec"
import { EDITOR_FRAGMENT } from "../gl-admin/lib/collaboration/fragmentBridge"
import { schemaFingerprint } from "../gl-admin/lib/collaboration/schemaFingerprint"
import { getInstalledCollabSchema } from "../gl-admin/lib/theme-blocks/collabSchema"
import { docKind, TicketReplayGuard, type CollabDocRef, type TicketClaims } from "./access"
import type { CollabBlockEdit, CollabRecord, CollabStoreBody, CollabStoreResult, InternalApi } from "./api"
import { AuthRejection, createAuthenticate, DENY, type CollabContext } from "./auth"
import { BlockChangeTracker, blockEditsFor, type BlockEditCapture } from "./blockEdits"
import { loadIntoDoc, readMeta, SERVER_ORIGIN } from "./load"
import { docNameForLog, errorMessage, logEvent } from "./logsafe"
import { createAccessRecheck, type AccessRecheckOptions } from "./recheck"
import { applyRestore, InvalidVersionError, planRestore, type RestorePlan } from "./restore"
import { prepareStore } from "./store"

export interface CollabServerOptions {
  api: InternalApi
  verifyTicket(ticket: string, docName: string): Promise<TicketClaims>
  port: number
  address?: string
  /** onStoreDocument debounce (ms). */
  debounce?: number
  maxDebounce?: number
  /**
   * Default: the core schema plus every installed theme block (#376). Clients must bind
   * with the same schema: the auth hook refuses any other fingerprint (#416).
   */
  schema?: Schema
  newEpoch?: () => string
  /** First retry delay after a failed store (doubles up to 60s). */
  storeRetryMs?: number
  /** Interval, jitter, grace period and clock of the access re-check (recheck.ts). */
  accessRecheck?: Omit<AccessRecheckOptions, "fetchAccess">
}

/** Sent to every client of a doc with broadcastStateless after each store attempt. */
export type StoreMessage =
  | {
      type: "stored"
      revision: number | null
      block_doc: "written" | "kept-invalid" | "kept-empty" | "unchanged"
      /**
       * The attribution this store just wrote (#328): only with `block_doc: "written"`,
       * after the PUT succeeded, and only when there is some. Open editors merge it into
       * what they read from GET /posts/:id/block-edits; older tabs ignore it.
       */
      edits?: CollabBlockEdit[]
    }
  | { type: "store_failed" }

/** Sent to every client of a doc when the API says its comments changed (#192). */
export type CommentsMessage = { type: "comments" }

export type StoreResult = { ok: true; skipped: boolean } | { ok: false; error: string }

/**
 * What a server-side restore (#286) did. `ok: true` means the version is in the live doc
 * AND stored (block_doc and the Yjs state); anything else means neither changed.
 *   - `not-a-post`: only post-<id> docs are restored here (templates keep the editor path);
 *   - `invalid-version`: the version isn't a Block Spec v1 document;
 *   - `not-found`: the post doesn't exist;
 *   - `unstorable`: the restored doc would fail the store's validation (it would be
 *     kept-invalid, so block_doc would never get it);
 *   - `unavailable`: the doc couldn't be loaded or the store failed (retry later).
 */
export type RestoreResult =
  | { ok: true; revision: number | null; block_doc: "written" | "unchanged"; dropped: number }
  | { ok: false; reason: "not-a-post" | "invalid-version" | "not-found" | "unstorable" | "unavailable"; error: string }

/**
 * Origin of the restore's update when it is applied to the live doc. A string: no
 * Connection context, so the block change tracker and onChange ignore it (the restore's
 * attribution went with its own store), and Hocuspocus still broadcasts it to every
 * connection and schedules the usual debounced store (skipped when nothing else changed).
 */
export const RESTORE_ORIGIN = "golive-collab-restore"

interface Session {
  /** Which document this is (#490): a post, or a template or part (`template-<id>`). */
  doc: CollabDocRef
  /** The rules its stores are validated with: `post`, or the template's `template` / `part`. */
  kind: BlockDocKind
  previous: BlockDocV1 | null
  revision: number | null
  clientEdited: boolean
  lastEditorId: string | null
  /** Snapshot of the doc as last stored; equal → nothing to store. */
  storedSnapshot: Y.Snapshot | null
  failed: boolean
  retryTimer: NodeJS.Timeout | null
  retryDelay: number
  /**
   * Which block each user changed since the last store that wrote block_doc (#328). Posts
   * only: off for templates in v1 (design 7.2), which show no per-block attribution.
   */
  tracker: BlockChangeTracker | null
}

/** onLoadDocument for a post or template the API doesn't have (404). */
class DocNotFoundError extends Error {
  constructor(kind: CollabDocRef["kind"]) {
    super(`${kind} not found`)
    this.name = "DocNotFoundError"
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
    schema = getInstalledCollabSchema(),
    newEpoch,
    storeRetryMs = 2000,
  } = options
  const fingerprint = schemaFingerprint(schema)
  const sessions = new Map<string, Session>()
  const replayGuard = new TicketReplayGuard()
  const recheck = createAccessRecheck({
    ...options.accessRecheck,
    fetchAccess: (identity, docName, { requestId }) => api.fetchAccess(identity, docName, { requestId }),
  })
  let hocuspocus: Hocuspocus

  // The API client per document kind (#490, design 7.2): a post's body through
  // /internal/posts/:id/collab, a template or part through /internal/site-templates/:id/collab,
  // with the #280 contract unchanged.
  const getRecord = (ref: CollabDocRef, opts: { requestId?: string }): Promise<CollabRecord | null> =>
    ref.kind === "post" ? api.getCollab(ref.id, opts) : api.getTemplateCollab(ref.id, opts)
  const putRecord = (ref: CollabDocRef, body: CollabStoreBody, opts: { requestId?: string } = {}): Promise<CollabStoreResult> =>
    ref.kind === "post" ? api.putCollab(ref.id, body, opts) : api.putTemplateCollab(ref.id, body, opts)

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
    schemaFingerprint: fingerprint,
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
        if (error instanceof DocNotFoundError) throw new AuthRejection(DENY.forbidden, "Document not found")
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
    // Per-block attribution (#328), only with a block_doc write, resolved after the ids
    // were stamped, and against the doc this store replaces. A tracker failure costs the
    // attribution, never the store.
    let capture: BlockEditCapture | null = null
    let edits: CollabBlockEdit[] = []
    if (decision.write && session.tracker) {
      try {
        capture = session.tracker.capture()
        const fallback =
          session.clientEdited && session.lastEditorId ? { userId: session.lastEditorId, at: Date.now() } : null
        edits = blockEditsFor(decision.blockDoc, session.previous, capture, fallback)
        if (edits.length > 0) body.block_edits = edits
      } catch (error) {
        capture = null
        edits = []
        logEvent("warn", "collab_block_edits_failed", { doc, error: errorMessage(error) })
      }
    }
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
      const result = await putRecord(session.doc, body)
      if (decision.write) session.previous = decision.blockDoc
      // Only what this store was prepared with; edits made during the PUT stay.
      if (capture) session.tracker?.clear(capture)
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
        block_edits: edits.length || undefined,
        bytes: body.state.length,
      })
      broadcast(document, {
        type: "stored",
        revision: session.revision,
        block_doc: kept,
        ...(decision.write && edits.length > 0 ? { edits } : {}),
      })
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
      const ref = docKind(documentName)
      if (!ref) throw new Error("invalid document name")
      const requestId = contextOf(context).requestId
      const doc = docNameForLog(documentName)
      let record: CollabRecord | null
      try {
        record = await getRecord(ref, { requestId })
      } catch (error) {
        logEvent("error", "collab_load_failed", { request_id: requestId, doc, error: errorMessage(error) })
        throw error
      }
      if (!record) {
        logEvent("warn", "collab_load_failed", { request_id: requestId, doc, error: `${ref.kind} not found` })
        throw new DocNotFoundError(ref.kind)
      }
      // A template's stores follow its kind's rules (template or part). One without a
      // known kind fails the load: storing it under the wrong rules could let a part hold
      // a template_part.
      const kind: BlockDocKind | null = ref.kind === "post" ? "post" : record.doc_kind === "template" || record.doc_kind === "part" ? record.doc_kind : null
      if (!kind) {
        logEvent("error", "collab_load_failed", { request_id: requestId, doc, error: "the template has no known kind" })
        throw new Error("the template has no known kind")
      }
      // The same loadIntoDoc for every kind (design 7.2): the only place a doc is seeded
      // (rule 11), with #453's reseed of uninstalled extension blocks for templates too.
      const outcome = loadIntoDoc(document, record, schema, newEpoch)
      const session: Session = {
        doc: ref,
        kind,
        previous: record.block_doc,
        revision: record.block_revision,
        clientEdited: false,
        lastEditorId: null,
        storedSnapshot: outcome.kind === "restored" ? Y.snapshot(document) : null,
        failed: false,
        retryTimer: null,
        retryDelay: storeRetryMs,
        // After the load: what it wrote (seed, cleanup) is the server's, not a client's.
        // Posts only (design 7.2: off for templates in v1).
        tracker: ref.kind === "post" ? new BlockChangeTracker(document.getXmlFragment(EDITOR_FRAGMENT)) : null,
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
      // The #453 check threw: the state was applied as it was (an uninstalled block in it
      // still makes the editor open the post read-only).
      if (outcome.kind === "restored" && outcome.reseedError) {
        logEvent("warn", "collab_reseed_check_failed", { request_id: requestId, doc, error: outcome.reseedError })
      }

      // Persist a seed right away (Yjs state and epoch only; block_doc is what it was
      // seeded from), so a reload or restart restores this epoch instead of reseeding.
      if (outcome.kind === "seeded") {
        try {
          const { epoch } = readMeta(document)
          await putRecord(
            ref,
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
      session?.tracker?.destroy()
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

  /**
   * Restores a stored version into a post's working copy (#286), loaded or not: the API's
   * POST /posts/:id/versions/:no/restore calls it through the internal listener, after its
   * own access check. It replaces the "default" fragment's content in one Yjs transaction
   * (restore.ts) and stores it, under the doc's saveMutex, so no debounced store runs in
   * between.
   *
   * All or nothing: the restore is applied to a SCRATCH copy of the live doc first, which
   * goes through the store pipeline (repairs, ids, validation, block_doc) and is PUT to the
   * API. Only once the API stored it is the same update applied to the live doc, which
   * broadcasts it to every connection as an ordinary remote change, followed by the
   * `stored` message. A load that fails, a doc that wouldn't validate (kept-invalid) or a
   * failed PUT leave the live doc, its state and block_doc as they were.
   *
   * Edits that arrive while the PUT is in flight land in the live doc and merge with the
   * restore like any concurrent edit (CRDT); the usual debounced store then stores them.
   * The restore's blocks are attributed to `userId` (#328) in the store that writes them.
   */
  async function restore(docName: string, version: unknown, { userId, requestId }: { userId: string; requestId?: string }): Promise<RestoreResult> {
    const doc = docNameForLog(docName)
    const refuse = (reason: Exclude<RestoreResult, { ok: true }>["reason"], error: string): RestoreResult => {
      logEvent(reason === "unavailable" ? "error" : "warn", "collab_restore_failed", { request_id: requestId, doc, user_id: userId, reason, error })
      return { ok: false, reason, error }
    }
    // Templates and parts (#492) keep the editor path: their restore records working_state
    // and a Start over's source once the store lands, and a reset item must be unlocked first.
    const ref = docKind(docName)
    if (!ref || ref.kind !== "post") return refuse("not-a-post", "only posts are restored on the server")

    let plan: RestorePlan
    try {
      plan = planRestore(version, schema)
    } catch (error) {
      return refuse("invalid-version", error instanceof InvalidVersionError ? error.message : errorMessage(error))
    }

    let connection: Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>
    try {
      // Loads the doc (seeding it if it has no usable state, rule 11) and keeps it loaded
      // until disconnect, which unloads it again if nobody else is connected.
      connection = await hocuspocus.openDirectConnection(docName, { requestId })
    } catch (error) {
      if (error instanceof DocNotFoundError) return refuse("not-found", "post not found")
      return refuse("unavailable", `load failed: ${errorMessage(error)}`)
    }
    try {
      const document = connection.document
      if (!document) return refuse("unavailable", "the document closed")
      const result = await document.saveMutex.runExclusive(() => restoreLoaded(docName, document, plan, userId, requestId))
      return result.ok ? result : refuse(result.reason, result.error)
    } catch (error) {
      // Anything before the live doc was touched (it's only touched after the PUT).
      return refuse("unavailable", errorMessage(error))
    } finally {
      await connection.disconnect().catch(() => {})
    }
  }

  async function restoreLoaded(
    docName: string,
    document: Document,
    plan: RestorePlan,
    userId: string,
    requestId: string | undefined,
  ): Promise<RestoreResult> {
    const session = sessions.get(docName)
    if (!session) return { ok: false, reason: "unavailable", error: "the document is not loaded" }

    // The live doc as it is now, copied; the restore is written there first.
    const before = Y.encodeStateVector(document)
    const scratch = new Y.Doc()
    let tracker: BlockChangeTracker | null = null
    try {
      Y.applyUpdate(scratch, Y.encodeStateAsUpdate(document), SERVER_ORIGIN)
      // Who changed which block (#328), on the copy: the restore's transaction carries the
      // restoring user as a Connection's context would, so every block it changes is theirs.
      tracker = session.tracker ? new BlockChangeTracker(scratch.getXmlFragment(EDITOR_FRAGMENT)) : null
      applyRestore(scratch, plan, { context: { userId } })

      let prepared: ReturnType<typeof prepareStore>
      try {
        prepared = prepareStore(scratch, schema, { previous: session.previous, clientEdited: true, lastEditorId: userId, kind: session.kind })
      } catch (error) {
        return { ok: false, reason: "unstorable", error: errorMessage(error) }
      }
      const { body, decision } = prepared
      // A restore the store would keep out of block_doc is refused instead: applying it
      // would put content in the editor that never reaches block_doc, publish or History.
      if (!decision.write && decision.reason === "invalid") return { ok: false, reason: "unstorable", error: decision.error }
      withBaseRevision(body, session)
      let edits: CollabBlockEdit[] = []
      if (decision.write && tracker) {
        try {
          edits = blockEditsFor(decision.blockDoc, session.previous, tracker.capture(), { userId, at: Date.now() })
          if (edits.length > 0) body.block_edits = edits
        } catch (error) {
          edits = []
          logEvent("warn", "collab_block_edits_failed", { doc: docNameForLog(docName), error: errorMessage(error) })
        }
      }

      let stored: CollabStoreResult
      try {
        stored = await putRecord(session.doc, body, { requestId })
      } catch (error) {
        return { ok: false, reason: "unavailable", error: `store failed: ${errorMessage(error)}` }
      }

      // Stored: the live doc gets exactly the structs that were stored (the restore, plus
      // the ids and repairs the store pipeline wrote), and every connection with it.
      Y.applyUpdate(document, Y.encodeStateAsUpdate(scratch, before), RESTORE_ORIGIN)
      if (decision.write) session.previous = decision.blockDoc
      if (stored.block_revision !== null) session.revision = stored.block_revision
      // Equal to the live doc unless edits arrived during the PUT; then the next store runs.
      session.storedSnapshot = Y.snapshot(scratch)
      session.clientEdited = true
      session.lastEditorId = userId
      session.failed = false
      session.retryDelay = storeRetryMs
      if (session.retryTimer) clearTimeout(session.retryTimer)
      session.retryTimer = null
      const kept = decision.write ? "written" : "unchanged"
      logEvent("info", "collab_restore", {
        request_id: requestId,
        doc: docNameForLog(docName),
        user_id: userId,
        block_doc: kept,
        revision: session.revision,
        dropped_blocks: plan.dropped.entries.length || undefined,
        block_edits: edits.length || undefined,
        connections: document.getConnectionsCount(),
      })
      broadcast(document, {
        type: "stored",
        revision: session.revision,
        block_doc: kept,
        ...(decision.write && edits.length > 0 ? { edits } : {}),
      })
      return { ok: true, revision: session.revision, block_doc: kept, dropped: plan.dropped.entries.length }
    } finally {
      tracker?.destroy()
      scratch.destroy()
    }
  }

  return {
    server,
    get hocuspocus() {
      return hocuspocus
    },
    flush,
    /** Restores a version into a post's working copy, open or not (#286; internal listener). */
    restore,
    /** The schema fingerprint clients must send (#416). */
    schemaFingerprint: fingerprint,
    /** Re-checks a user's open connections now (internal listener, #333). */
    recheckUser: (userId: string) => recheck.checkUser(userId),
    /** Re-checks a document's open connections now (internal listener; trash, #327). */
    recheckDoc: (docName: string) => recheck.checkDoc(docName),
    /**
     * Tells a loaded doc's connections that its comments changed (#192): a stateless
     * {"type":"comments"}, read-only connections included, so open editors refetch them
     * from the API. Never loads a doc and never touches its content. Returns how many
     * connections it reached (0 when the doc isn't loaded: nobody to tell).
     */
    notifyComments(docName: string): number {
      const document = hocuspocus.documents.get(docName)
      if (!document) return 0
      const message: CommentsMessage = { type: "comments" }
      try {
        document.broadcastStateless(JSON.stringify(message))
      } catch {
        return 0
      }
      return document.getConnectionsCount()
    },
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
