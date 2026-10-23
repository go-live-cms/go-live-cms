// The API's internal listener, as the collab server uses it (#206, #280). Every call
// goes to INTERNAL_API_URL (:8081, never published) with the shared ROLE_LOOKUP_SECRET
// (requireInternalSecret in api/internal_routes.go). No user credential is ever sent.
//
//   GET /internal/users/:id/access?doc=&issued_at=  → { role, can_edit }   (access.ts)
//   GET /internal/posts/:id/collab                  → CollabRecord
//   PUT /internal/posts/:id/collab  CollabStoreBody → { block_revision }
//
// Must NOT import yjs.
import type { BlockDocV1 } from "../gl-admin/lib/blocks-spec"
import { fetchDocAccess, type DocAccess, type TicketIdentity } from "./access"

/**
 * GET /internal/posts/:id/collab. `ydoc_state` (base64 of `encodeStateAsUpdate`) and
 * `epoch` are present when the post has stored Yjs state. The API returns them only when
 * that state was produced at the post's current `block_revision`; if it also sends
 * `ydoc_block_revision`, the server checks the match itself (a stale state is reseeded).
 */
export interface CollabRecord {
  block_doc: BlockDocV1 | null
  block_revision: number
  ydoc_state?: string | null
  epoch?: string | null
  ydoc_block_revision?: number | null
}

/**
 * PUT /internal/posts/:id/collab. Without `block_doc` only the Yjs state is stored and
 * `posts.block_doc` (and its revision) stay as they are: what the server sends when the
 * derived doc failed validation or is an unexplained empty doc.
 */
export interface CollabStoreBody {
  state: string
  epoch: string
  block_doc?: BlockDocV1
  last_editor_id?: number
  /**
   * The `block_revision` the doc was loaded at or last stored at. The API refuses the
   * store (409) if `block_doc` moved since, and requires it on a state-only store (400
   * without): the state is recorded against the current revision.
   */
  base_revision?: number
}

export interface CollabStoreResult {
  block_revision: number | null
}

/**
 * `posts.block_doc` as the server may use it: a Block Spec doc, or null for "no content".
 * Posts that never had blocks store `{}` (most seeded posts, and posts created without a
 * body), with no `blocks`/`blocks_order`. Anything that isn't shaped like a Block Spec doc
 * becomes null, which load seeds as an empty document and store treats as empty (#304).
 * Deeper problems inside a well-shaped doc are left to the seed/validation pipeline.
 */
export function normalizeBlockDoc(raw: unknown): BlockDocV1 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const doc = raw as { blocks?: unknown; blocks_order?: unknown }
  if (!Array.isArray(doc.blocks_order)) return null
  if (!doc.blocks || typeof doc.blocks !== "object" || Array.isArray(doc.blocks)) return null
  return raw as BlockDocV1
}

export class InternalApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = "InternalApiError"
  }
}

export interface InternalApi {
  fetchAccess(identity: TicketIdentity, docName: string, opts?: { requestId?: string }): Promise<DocAccess | null>
  /** null when the post doesn't exist (404). */
  getCollab(postId: string, opts?: { requestId?: string }): Promise<CollabRecord | null>
  putCollab(postId: string, body: CollabStoreBody, opts?: { requestId?: string }): Promise<CollabStoreResult>
}

export interface InternalApiConfig {
  apiUrl: string
  secret: string
  fetchImpl?: typeof fetch
  /** Role lookups: the client is waiting on the handshake. */
  accessTimeoutMs?: number
  /** Loads and stores carry whole documents. */
  documentTimeoutMs?: number
}

export function createInternalApi({
  apiUrl,
  secret,
  fetchImpl = fetch,
  accessTimeoutMs = 3000,
  documentTimeoutMs = 10_000,
}: InternalApiConfig): InternalApi {
  const base = apiUrl.replace(/\/+$/, "")
  const headers = (requestId?: string): Record<string, string> => {
    const h: Record<string, string> = { Authorization: `Bearer ${secret}`, Accept: "application/json" }
    if (requestId) h["X-Request-ID"] = requestId
    return h
  }
  const collabUrl = (postId: string) => `${base}/internal/posts/${encodeURIComponent(postId)}/collab`
  const fail = (what: string, status: number): never => {
    if (status === 401) throw new InternalApiError(`${what} failed: API rejected ROLE_LOOKUP_SECRET (401)`, status)
    throw new InternalApiError(`${what} failed: API responded ${status}`, status)
  }

  return {
    fetchAccess: (identity, docName, { requestId } = {}) =>
      fetchDocAccess(base, identity, docName, secret, { fetchImpl, timeoutMs: accessTimeoutMs, requestId }),

    async getCollab(postId, { requestId } = {}) {
      const res = await fetchImpl(collabUrl(postId), {
        method: "GET",
        headers: headers(requestId),
        signal: AbortSignal.timeout(documentTimeoutMs),
      })
      if (res.status === 404) return null
      if (!res.ok) fail("collab load", res.status)
      const body = (await res.json()) as Partial<CollabRecord> | null
      if (!body || typeof body.block_revision !== "number") {
        throw new InternalApiError("collab load failed: malformed response", res.status)
      }
      return {
        block_doc: normalizeBlockDoc(body.block_doc),
        block_revision: body.block_revision,
        ydoc_state: body.ydoc_state ?? null,
        epoch: body.epoch ?? null,
        ydoc_block_revision: typeof body.ydoc_block_revision === "number" ? body.ydoc_block_revision : null,
      }
    },

    async putCollab(postId, body, { requestId } = {}) {
      const res = await fetchImpl(collabUrl(postId), {
        method: "PUT",
        headers: { ...headers(requestId), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(documentTimeoutMs),
      })
      if (!res.ok) fail("collab store", res.status)
      const result = (await res.json().catch(() => null)) as { block_revision?: unknown } | null
      return { block_revision: typeof result?.block_revision === "number" ? result.block_revision : null }
    },
  }
}
