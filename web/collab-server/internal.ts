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

export interface InternalServerOptions {
  secret: string
  flush(docName: string): Promise<FlushResult>
}

/** Constant-time "Authorization: Bearer <secret>" check. An empty secret rejects everything. */
export function bearerMatches(header: string | string[] | undefined, secret: string): boolean {
  if (!secret) return false
  const got = Buffer.from(String(Array.isArray(header) ? header[0] : (header ?? "")).trim())
  const expected = Buffer.from(`Bearer ${secret}`)
  return got.length === expected.length && timingSafeEqual(got, expected)
}

const FLUSH_PATH = /^\/internal\/documents\/([^/]+)\/flush$/

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
}

export function createInternalHandler({ secret, flush }: InternalServerOptions) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = requestIdFrom(req.headers["x-request-id"])
    res.setHeader("X-Request-ID", requestId)
    const path = (req.url || "/").split("?")[0]

    if (path === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" })
      return send(res, 200, { ok: true })
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
