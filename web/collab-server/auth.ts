// onAuthenticate (#206): the order of the old y-websocket server's upgrade.js, on
// Hocuspocus's auth message.
//
//   doc name (isCollabDocName) → ticket present → verifyTicket (sig, iss, aud, type,
//   exp, doc === documentName) → burn the jti (TicketReplayGuard, before the lookup, so a
//   failed lookup can't be retried with the same ticket) → ticketIdentity → schema
//   fingerprint (#416) → the API's access lookup (3s timeout, X-Request-ID) → read-write
//   / read-only / deny → epoch.
//
// Throwing rejects the connection: Hocuspocus sends `permission-denied` with our
// `reason`, and the client fetches a fresh ticket before it retries. The ticket arrives
// in the auth message (not the URL), is never logged, and never leaves this process.
// Users are logged by id only (#155).
//
// The auth message carries the ticket and the client's schema fingerprint as JSON
// (gl-admin/lib/collaboration/schemaFingerprint.ts). A fingerprint that isn't the
// server's, or none (a bundle from before #416), is refused with `schema-mismatch`
// before the access lookup and before the doc is loaded, so the refused editor never
// syncs and nothing is written for it. A connection already open keeps going until it
// reconnects (a deploy's collab restart forces that).
//
// Dependencies are injected so the matrix is unit tested (auth.test.ts). Must NOT
// import yjs.
import type { IncomingHttpHeaders } from "node:http"
import { decodeCollabAuthToken, SCHEMA_FINGERPRINT_PATTERN } from "../gl-admin/lib/collaboration/schemaFingerprint"
import { accessMode, isCollabDocName, ticketIdentity, type DocAccess, type TicketClaims, type TicketIdentity } from "./access"
import { clientContextForLog, docNameForLog, errorMessage, logEvent, requestIdFrom } from "./logsafe"

/** Reasons sent to the client in the permission-denied message. */
export const DENY = {
  /** Bad doc name, missing/invalid/used ticket, no access. Fetch a new ticket only if you expect it to help. */
  forbidden: "permission-denied",
  /** The API couldn't answer the access lookup. Retry with a fresh ticket. */
  unavailable: "access-unavailable",
  /** The client's epoch isn't the doc's: drop the local Y.Doc and reconnect fresh. */
  staleEpoch: "stale-epoch",
  /** The post is in the trash (#327): don't retry; the editor says so. */
  trashed: "post-trashed",
  /**
   * The client's editor schema isn't this server's (#416), or it sent no fingerprint: don't
   * retry, reload (a new bundle). Binding would let y-tiptap delete types it can't build.
   */
  schemaMismatch: "schema-mismatch",
} as const

/** A fingerprint as it may be logged: its first 12 characters, "missing" or "invalid". */
export function fingerprintForLog(fingerprint: string | null): string {
  if (fingerprint === null) return "missing"
  return SCHEMA_FINGERPRINT_PATTERN.test(fingerprint) ? fingerprint.slice(0, 12) : "invalid"
}

export class AuthRejection extends Error {
  constructor(readonly reason: string, message: string) {
    super(message)
    this.name = "AuthRejection"
  }
}

/** What onAuthenticate adds to the Hocuspocus connection context. */
export interface CollabContext {
  userId: string
  /** The ticket's iat (Unix seconds): the access re-check sends it again (recheck.ts). */
  issuedAt: number
  role: string | null
  requestId: string
  readOnly: boolean
}

export interface AuthDeps {
  verifyTicket(ticket: string, docName: string): Promise<TicketClaims>
  /** false when the ticket was already used. */
  consumeTicket(claims: TicketClaims): boolean
  fetchAccess(identity: TicketIdentity, docName: string, opts: { requestId: string }): Promise<DocAccess | null>
  /**
   * The epoch the doc has (or will have once loaded). Only called when the client sent
   * one. null if it can't be determined, which rejects the client's epoch.
   */
  currentEpoch(docName: string, opts: { requestId: string }): Promise<string | null>
  /** This server's schema fingerprint (schemaFingerprint of the schema it converts with). */
  schemaFingerprint: string
}

export interface AuthPayload {
  token: string
  documentName: string
  requestHeaders: IncomingHttpHeaders
  requestParameters: URLSearchParams
  request?: { socket?: { remoteAddress?: string } }
  connectionConfig: { readOnly: boolean }
}

export function createAuthenticate(deps: AuthDeps) {
  return async (payload: AuthPayload): Promise<CollabContext> => {
    const requestId = requestIdFrom(payload.requestHeaders?.["x-request-id"])
    const rawDocName = payload.documentName
    const docName = docNameForLog(rawDocName)

    // Rejections log the client context (origin, UA, peer IP) to make them traceable;
    // accepted connections don't, so we don't retain that for every editor connect.
    const reject = (
      reason: string,
      logReason: string,
      { warn = false, userId, fields }: { warn?: boolean; userId?: string; fields?: Record<string, string> } = {},
    ) => {
      logEvent(warn ? "warn" : "error", "ws_deny", {
        request_id: requestId,
        doc: docName,
        reason: logReason,
        sent: reason,
        user_id: userId,
        ...fields,
        client: clientContextForLog(payload.requestHeaders, payload.request?.socket?.remoteAddress),
      })
      return new AuthRejection(reason, logReason)
    }

    if (!isCollabDocName(rawDocName)) {
      throw reject(DENY.forbidden, "Invalid document name", { warn: true })
    }
    const { ticket, schema: clientSchema } = decodeCollabAuthToken(payload.token)
    if (!ticket) {
      throw reject(DENY.forbidden, "No ticket provided")
    }

    let claims: TicketClaims
    try {
      claims = await deps.verifyTicket(ticket, rawDocName)
    } catch (error) {
      throw reject(DENY.forbidden, `Ticket rejected: ${errorMessage(error)}`)
    }
    const claimedUserId = claims.user_id == null ? undefined : String(claims.user_id)

    // Single use: a ticket that leaked can't open a second connection. Burned before the
    // access lookup, so a failed lookup can't be retried with it.
    if (!deps.consumeTicket(claims)) {
      throw reject(DENY.forbidden, "Ticket already used", { warn: true, userId: claimedUserId })
    }

    const identity = ticketIdentity(claims)
    if (!identity) {
      throw reject(DENY.forbidden, "Ticket has no valid user_id/iat", { userId: claimedUserId })
    }

    // Before the access lookup and long before the doc is loaded (the epoch check below
    // loads it, and a load may seed and store): a refused editor causes no write at all.
    if (clientSchema !== deps.schemaFingerprint) {
      throw reject(
        DENY.schemaMismatch,
        clientSchema === null ? "No editor schema fingerprint (an editor from before #416)" : "Editor schema differs from the server's",
        {
          warn: true,
          userId: identity.userId,
          fields: { client_schema: fingerprintForLog(clientSchema), server_schema: fingerprintForLog(deps.schemaFingerprint) },
        },
      )
    }

    let access: DocAccess | null
    try {
      access = await deps.fetchAccess(identity, rawDocName, { requestId })
    } catch (error) {
      throw reject(DENY.unavailable, `Access lookup failed: ${errorMessage(error)}`, { userId: identity.userId })
    }
    if (access?.trashed) {
      throw reject(DENY.trashed, "The post is in the trash", { warn: true, userId: identity.userId })
    }
    const mode = accessMode(access)
    if (!mode) {
      throw reject(DENY.forbidden, `Forbidden: role ${access?.role || "none"} cannot open this document`, {
        warn: true,
        userId: identity.userId,
      })
    }

    // A client that already holds this doc says which epoch its structs belong to. If the
    // server reseeded since (new epoch), merging them would duplicate the content.
    const clientEpoch = payload.requestParameters?.get("epoch")
    if (clientEpoch) {
      let epoch: string | null
      try {
        epoch = await deps.currentEpoch(rawDocName, { requestId })
      } catch (error) {
        // currentEpoch throws an AuthRejection for a final answer (the post is gone);
        // anything else is an outage the client retries.
        const reason = error instanceof AuthRejection ? error.reason : DENY.unavailable
        throw reject(reason, `Epoch check failed: ${errorMessage(error)}`, { userId: identity.userId })
      }
      if (epoch !== clientEpoch) {
        throw reject(DENY.staleEpoch, "Client epoch does not match the document", { warn: true, userId: identity.userId })
      }
    }

    const readOnly = mode === "read"
    payload.connectionConfig.readOnly = readOnly
    return { userId: identity.userId, issuedAt: identity.issuedAt, role: access?.role ?? null, requestId, readOnly }
  }
}
