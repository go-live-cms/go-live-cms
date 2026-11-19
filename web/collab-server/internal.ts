// Internal HTTP listener (#206): its own port, never published, modeled on the API's
// internal router (api/internal_routes.go).
//
//   GET  /healthz                          → 200 {"ok":true}  (unauthenticated: docker
//                                            healthcheck; says nothing about any doc)
//   POST /internal/documents/:doc/flush    → store the doc now and wait for it (the API's
//                                            publish calls this before reading block_doc)
//        200 {"flushed":true|false}  stored, or nothing to store / not loaded
//        400  not a collab doc name
//        401  missing or wrong "Authorization: Bearer <COLLAB_INTERNAL_SECRET>"
//        503  the store failed (publish must not go ahead with a stale block_doc)
//   POST /internal/users/:id/recheck       → look up the access of the user's open
//                                            connections now (recheck.ts `checkUser`;
//                                            the API calls it after a role change or a
//                                            removal, #333). Answers once it is queued.
//        200 {"docs": n}  how many of their (user, doc) groups are being re-checked
//        400  not a user id
//        401  missing or wrong secret
//   POST /internal/documents/:doc/recheck  → the same for every open connection to one
//                                            document (`checkDoc`; the API calls it after
//                                            the post moves to the trash, #327, so they
//                                            close with post-trashed now)
//        200 {"docs": n}  how many (user, doc) groups are being re-checked
//        400  not a collab doc name
//        401  missing or wrong secret
//   POST /internal/documents/:doc/comments → tell the doc's open connections that its
//                                            comments changed (#192): a stateless
//                                            {"type":"comments"}; the editors refetch
//                                            them from the API. Content is untouched.
//        200 {"connections": n}  how many it reached (0: not loaded, nobody to tell)
//        400  not a collab doc name
//        401  missing or wrong secret
//   POST /internal/documents/:doc/restore  → put a stored version into a post's working
//        {"block_doc": …, "user_id": "7"}    copy, loaded or not (#286; the API's POST
//                                            /posts/:id/versions/:no/restore calls it after
//                                            its own access check). Answers once it is in
//                                            the live doc AND stored; otherwise nothing
//                                            changed (server.ts `restore`).
//        200 {"restored":true,"revision":n,"block_doc":"written"|"unchanged","dropped":n}
//        400  not a post's doc name, bad JSON, no user id, not a Block Spec v1 version
//        401  missing or wrong secret
//        404  the post doesn't exist
//        413  body over RESTORE_BODY_LIMIT
//        422  the restored doc wouldn't pass the store's validation
//        503  the doc couldn't be loaded or the store failed (retry later)
//
// Must NOT import yjs.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { isCollabDocName } from "./access"
import { docNameForLog, logEvent, requestIdFrom } from "./logsafe"

export interface FlushResult {
  ok: boolean
  skipped?: boolean
  loaded?: boolean
  error?: string
}

/** server.ts `RestoreResult`, restated here so this file needs nothing that imports yjs. */
export type RestoreResult =
  | { ok: true; revision: number | null; block_doc: "written" | "unchanged"; dropped: number }
  | { ok: false; reason: "not-a-post" | "invalid-version" | "not-found" | "unstorable" | "unavailable"; error: string }

export interface InternalServerOptions {
  secret: string
  flush(docName: string): Promise<FlushResult>
  /** Re-checks the user's open connections now; returns how many docs. */
  recheckUser(userId: string): number
  /** Re-checks every open connection to the doc now (#327); returns how many groups. */
  recheckDoc(docName: string): number
  /** Broadcasts the comments nudge to the doc's connections (#192); returns how many. */
  notifyComments(docName: string): number
  /** Restores a version into a post's working copy (#286). */
  restore(docName: string, version: unknown, opts: { userId: string; requestId?: string }): Promise<RestoreResult>
}

/**
 * The largest restore body read. The API stores block_doc up to 4 MiB
 * (`collabStoreBodyLimit` allows 16 MiB for the whole store); a version is one of those
 * plus a user id.
 */
export const RESTORE_BODY_LIMIT = 8 << 20

class BodyTooLargeError extends Error {}

/** The request body as text, refusing more than `limit` bytes. */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(req.headers["content-length"])
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new BodyTooLargeError()
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

const RESTORE_STATUS: Record<Exclude<RestoreResult, { ok: true }>["reason"], number> = {
  "not-a-post": 400,
  "invalid-version": 400,
  "not-found": 404,
  unstorable: 422,
  unavailable: 503,
}

const RESTORE_ERRORS: Record<Exclude<RestoreResult, { ok: true }>["reason"], string> = {
  "not-a-post": "only posts are restored here",
  "invalid-version": "the version is not a Block Spec v1 document",
  "not-found": "post not found",
  unstorable: "the restored document would not pass validation",
  unavailable: "restore failed",
}

/** Constant-time "Authorization: Bearer <secret>" check. An empty secret rejects everything. */
export function bearerMatches(header: string | string[] | undefined, secret: string): boolean {
  if (!secret) return false
  const got = Buffer.from(String(Array.isArray(header) ? header[0] : (header ?? "")).trim())
  const expected = Buffer.from(`Bearer ${secret}`)
  return got.length === expected.length && timingSafeEqual(got, expected)
}

const FLUSH_PATH = /^\/internal\/documents\/([^/]+)\/flush$/
const RECHECK_PATH = /^\/internal\/users\/([^/]+)\/recheck$/
const DOC_RECHECK_PATH = /^\/internal\/documents\/([^/]+)\/recheck$/
const COMMENTS_PATH = /^\/internal\/documents\/([^/]+)\/comments$/
const RESTORE_PATH = /^\/internal\/documents\/([^/]+)\/restore$/

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
}

export function createInternalHandler({ secret, flush, recheckUser, recheckDoc, notifyComments, restore }: InternalServerOptions) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = requestIdFrom(req.headers["x-request-id"])
    res.setHeader("X-Request-ID", requestId)
    const path = (req.url || "/").split("?")[0]

    if (path === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" })
      return send(res, 200, { ok: true })
    }

    const recheck = RECHECK_PATH.exec(path)
    if (recheck) {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" })
      if (!bearerMatches(req.headers.authorization, secret)) {
        logEvent("warn", "collab_recheck_denied", { request_id: requestId })
        return send(res, 401, { error: "unauthorized" })
      }
      const userId = recheck[1]
      if (!/^[1-9][0-9]{0,18}$/.test(userId)) return send(res, 400, { error: "invalid user id" })
      const docs = recheckUser(userId)
      logEvent("info", "collab_recheck", { request_id: requestId, user_id: userId, docs })
      return send(res, 200, { docs })
    }

    const docRecheck = DOC_RECHECK_PATH.exec(path)
    if (docRecheck) {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" })
      if (!bearerMatches(req.headers.authorization, secret)) {
        logEvent("warn", "collab_recheck_denied", { request_id: requestId })
        return send(res, 401, { error: "unauthorized" })
      }
      let docName: string
      try {
        docName = decodeURIComponent(docRecheck[1])
      } catch {
        return send(res, 400, { error: "invalid document name" })
      }
      if (!isCollabDocName(docName)) return send(res, 400, { error: "invalid document name" })
      const docs = recheckDoc(docName)
      logEvent("info", "collab_recheck", { request_id: requestId, doc: docNameForLog(docName), docs })
      return send(res, 200, { docs })
    }

    const comments = COMMENTS_PATH.exec(path)
    if (comments) {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" })
      if (!bearerMatches(req.headers.authorization, secret)) {
        logEvent("warn", "collab_comments_denied", { request_id: requestId })
        return send(res, 401, { error: "unauthorized" })
      }
      let docName: string
      try {
        docName = decodeURIComponent(comments[1])
      } catch {
        return send(res, 400, { error: "invalid document name" })
      }
      if (!isCollabDocName(docName)) return send(res, 400, { error: "invalid document name" })
      const connections = notifyComments(docName)
      logEvent("info", "collab_comments_nudge", { request_id: requestId, doc: docNameForLog(docName), connections })
      return send(res, 200, { connections })
    }

    const restorePath = RESTORE_PATH.exec(path)
    if (restorePath) {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" })
      if (!bearerMatches(req.headers.authorization, secret)) {
        logEvent("warn", "collab_restore_denied", { request_id: requestId })
        return send(res, 401, { error: "unauthorized" })
      }
      let docName: string
      try {
        docName = decodeURIComponent(restorePath[1])
      } catch {
        return send(res, 400, { error: "invalid document name" })
      }
      if (!isCollabDocName(docName)) return send(res, 400, { error: "invalid document name" })
      let body: { block_doc?: unknown; user_id?: unknown }
      try {
        const parsed: unknown = JSON.parse(await readBody(req, RESTORE_BODY_LIMIT))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
        body = parsed as typeof body
      } catch (error) {
        if (error instanceof BodyTooLargeError) return send(res, 413, { error: "body too large" })
        return send(res, 400, { error: "invalid JSON body" })
      }
      const userId = typeof body.user_id === "number" ? String(body.user_id) : body.user_id
      if (typeof userId !== "string" || !/^[1-9][0-9]{0,18}$/.test(userId)) return send(res, 400, { error: "invalid user id" })
      if (!("block_doc" in body)) return send(res, 400, { error: "block_doc is required" })

      const started = Date.now()
      const result = await restore(docName, body.block_doc, { userId, requestId }).catch(
        (error: unknown): RestoreResult => ({ ok: false, reason: "unavailable", error: error instanceof Error ? error.message : String(error) }),
      )
      logEvent("info", "collab_restore_request", {
        request_id: requestId,
        doc: docNameForLog(docName),
        user_id: userId,
        ok: result.ok,
        reason: result.ok ? undefined : result.reason,
        duration_ms: Date.now() - started,
      })
      if (!result.ok) return send(res, RESTORE_STATUS[result.reason], { error: RESTORE_ERRORS[result.reason], reason: result.reason })
      return send(res, 200, { restored: true, revision: result.revision, block_doc: result.block_doc, dropped: result.dropped })
    }

    const match = FLUSH_PATH.exec(path)
    if (!match) return send(res, 404, { error: "not found" })
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" })
    if (!bearerMatches(req.headers.authorization, secret)) {
      logEvent("warn", "collab_flush_denied", { request_id: requestId })
      return send(res, 401, { error: "unauthorized" })
    }

    let docName: string
    try {
      docName = decodeURIComponent(match[1])
    } catch {
      return send(res, 400, { error: "invalid document name" })
    }
    if (!isCollabDocName(docName)) return send(res, 400, { error: "invalid document name" })

    const started = Date.now()
    const result = await flush(docName).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))
    logEvent(result.ok ? "info" : "error", "collab_flush", {
      request_id: requestId,
      doc: docNameForLog(docName),
      ok: result.ok,
      loaded: "loaded" in result ? result.loaded : undefined,
      error: result.ok ? undefined : result.error,
      duration_ms: Date.now() - started,
    })
    if (!result.ok) return send(res, 503, { error: "store failed" })
    return send(res, 200, { flushed: !("skipped" in result && result.skipped) })
  }
}

export function createInternalServer(options: InternalServerOptions): Server {
  const handler = createInternalHandler(options)
  return createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "internal error" })
      else res.end()
    })
  })
}
