// Ticket auth + per-document access for collab connections. Ported from
// websocket/access.js (#216, #220, #223, #233, #135); the logic is the same, only the
// transport changed: Hocuspocus carries the ticket in its first auth message, not the URL.
//
// The editor never sends its access token to this server. Before each connect it asks
// the API for a ticket, a v4.public PASETO with audience golive.admin-ws, token_type
// ws_ticket, a `doc` claim, a jti and a 30s lifetime (token/ws_ticket.go). auth.ts then:
//   1. verifyTicket: checks signature, issuer, audience, type, expiry and doc locally;
//   2. a TicketReplayGuard burns the jti, so a ticket that leaked can never open a
//      second connection;
//   3. fetchDocAccess: asks the API's internal listener (GET /internal/users/:id/access,
//      a separate port that isn't published) what the user may do with this doc,
//      authenticated with the shared ROLE_LOOKUP_SECRET, NOT with the ticket (#223).
//      The ticket never leaves this process.
// The decision is the API's (canEditPost in api/auth_posts.go, #135), from the DB; a
// PASETO `role` claim (tickets carry none) is never used to authorize.
//
// Pure + dependency-injected (fetchImpl, keys, clock), unit tested in access.test.ts.
// Must NOT import yjs: see "Single yjs instance" in collab-server/CLAUDE.md.
import { V4 } from "paseto"
import { createPublicKey, type KeyObject } from "node:crypto"

// The API's PASETO_V4_PUBLIC_KEY_HEX (64 hex chars, the raw 32-byte Ed25519 key) as a
// KeyObject, so a deployment gives both services the same variable (#272). Throws on
// anything that isn't exactly 32 bytes of hex.
export function publicKeyFromHex(hex: string | undefined): KeyObject {
  const clean = String(hex || "").trim()
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error("PASETO_V4_PUBLIC_KEY_HEX must be 64 hex characters (a raw Ed25519 public key)")
  }
  const x = Buffer.from(clean, "hex").toString("base64url")
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" })
}

// Must match token.WSTicketAudience / token.WSTicketType in token/ws_ticket.go.
export const TICKET_AUDIENCE = "golive.admin-ws"
export const TICKET_TYPE = "ws_ticket"

// Clock skew tolerated when checking a ticket's expiry. The replay guard must remember a
// jti for at least this long past `exp`, or a burned ticket would verify again.
export const TICKET_CLOCK_TOLERANCE_MS = 5_000

// The only doc names the editor opens (`post-${postId}`). Anything else is rejected
// before auth, so a client can't make the server create and persist docs under
// arbitrary names, or put crafted text into log lines.
const COLLAB_DOC_NAME = /^post-[1-9]\d{0,18}$/

export function isCollabDocName(name: unknown): name is string {
  return typeof name === "string" && COLLAB_DOC_NAME.test(name)
}

/** The post id in a valid doc name ("post-12" → "12"), as a string (it may exceed 2^53). */
export function postIdOf(docName: string): string {
  if (!isCollabDocName(docName)) throw new Error("not a collab document name")
  return docName.slice("post-".length)
}

export interface TicketClaims {
  jti: string
  exp: string
  iat?: string
  sub?: string
  user_id?: string | number
  username?: string
  token_type?: string
  doc?: string
  [claim: string]: unknown
}

// Checks a ticket locally. Resolves to its claims; rejects if the signature, issuer,
// audience, expiry or type is wrong, it has no jti/exp (needed to burn it), or it was
// minted for another document. An access token (audience golive.admin, token_type
// access) is rejected.
export async function verifyTicket(
  ticket: string,
  publicKey: KeyObject,
  { issuer, docName }: { issuer: string; docName: string },
): Promise<TicketClaims> {
  const payload = (await V4.verify(ticket, publicKey, {
    issuer,
    audience: TICKET_AUDIENCE,
    clockTolerance: `${TICKET_CLOCK_TOLERANCE_MS / 1000}s`,
  })) as Record<string, unknown>
  if (payload.token_type !== TICKET_TYPE) {
    throw new Error("not a collab ticket")
  }
  if (typeof payload.doc !== "string" || payload.doc !== docName) {
    throw new Error("ticket was issued for a different document")
  }
  if (typeof payload.jti !== "string" || !payload.jti || !Number.isFinite(Date.parse(String(payload.exp)))) {
    throw new Error("ticket has no jti or exp")
  }
  return payload as TicketClaims
}

// Remembers burned ticket ids until they can no longer verify, which makes tickets
// single use. In memory, so it assumes ONE collab server process. That already holds:
// Hocuspocus keeps live docs in memory, so running two would split documents anyway.
// Only VERIFIED tickets are consumed, so a client can't grow the map with junk, and
// entries are dropped once their ticket is past exp + clock tolerance.
export class TicketReplayGuard {
  #used = new Map<string, number>() // jti → ms after which the ticket can't verify any more

  // Marks the ticket as used. Returns false if it already was.
  consume(payload: Pick<TicketClaims, "jti" | "exp">, now = Date.now()): boolean {
    for (const [jti, until] of this.#used) {
      if (now > until) this.#used.delete(jti)
    }
    if (this.#used.has(payload.jti)) return false
    this.#used.set(payload.jti, Date.parse(payload.exp) + TICKET_CLOCK_TOLERANCE_MS)
    return true
  }

  get size(): number {
    return this.#used.size
  }
}

export interface TicketIdentity {
  userId: string
  issuedAt: number
}

// Extracts what the access lookup needs from a VERIFIED ticket payload: the user's DB id
// (`user_id`, a decimal string set by token/ws_ticket.go) and `iat` as Unix seconds
// (so the API can refuse tickets issued before the user's latest password change).
// Returns null when either is missing or malformed → caller denies.
export function ticketIdentity(payload: Partial<TicketClaims> | null | undefined): TicketIdentity | null {
  const rawId = payload?.user_id
  const userId = typeof rawId === "number" ? String(rawId) : rawId
  if (typeof userId !== "string" || !/^[1-9]\d*$/.test(userId)) return null

  const issuedAtMs = typeof payload?.iat === "string" ? Date.parse(payload.iat) : NaN
  if (!Number.isFinite(issuedAtMs)) return null

  return { userId, issuedAt: Math.floor(issuedAtMs / 1000) }
}

export interface DocAccess {
  role: string | null
  canEdit: boolean
}

export interface InternalCallOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  requestId?: string
}

// Asks the API's internal endpoint what the user may do with the document.
//
// Returns:
//   - { role, canEdit } on 200 (canEdit is true only for a literal `true`)
//   - null on 403/404 (ticket predates a password change, user deleted, or the post is
//     gone) → caller denies
// Throws on any other status (including 401 = ROLE_LOOKUP_SECRET mismatch, a config
// error rather than a user error), a network error or a timeout → caller denies too,
// and the client retries with a fresh ticket. Never allowed without the API's answer.
// requestId is sent as X-Request-ID so the API logs the lookup under it.
export async function fetchDocAccess(
  apiUrl: string,
  { userId, issuedAt }: TicketIdentity,
  docName: string,
  secret: string,
  { fetchImpl = fetch, timeoutMs = 3000, requestId }: InternalCallOptions = {},
): Promise<DocAccess | null> {
  const url =
    `${apiUrl.replace(/\/+$/, "")}/internal/users/${encodeURIComponent(userId)}/access` +
    `?doc=${encodeURIComponent(docName)}&issued_at=${encodeURIComponent(issuedAt)}`
  const headers: Record<string, string> = { Authorization: `Bearer ${secret}`, Accept: "application/json" }
  if (requestId) headers["X-Request-ID"] = requestId
  const res = await fetchImpl(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (res.status === 403 || res.status === 404) return null
  if (res.status === 401) throw new Error("access lookup failed: API rejected ROLE_LOOKUP_SECRET (401)")
  if (!res.ok) throw new Error(`access lookup failed: API responded ${res.status}`)

  const body = (await res.json()) as { role?: unknown; can_edit?: unknown } | null
  return {
    role: typeof body?.role === "string" ? body.role : null,
    canEdit: body?.can_edit === true,
  }
}

// Roles that may read any post's working copy (GET /posts/:id/blocks is open to every
// signed-in content role). Must match the roles POST /collab/tickets mints for (#280).
export const READ_ROLES = new Set(["admin", "editor", "contributor"])

/**
 * What a connection may do, from the API's answer: "write" when it says the user may
 * edit this post (admins, editors, and a contributor on their own post), "read" for any
 * other content role (a contributor on someone else's post gets a live read-only view,
 * #206), null otherwise (deny).
 */
export function accessMode(access: DocAccess | null): "write" | "read" | null {
  if (!access) return null
  if (access.canEdit) return "write"
  return access.role && READ_ROLES.has(access.role) ? "read" : null
}
