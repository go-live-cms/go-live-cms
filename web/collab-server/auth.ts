// onAuthenticate (#206): the order of websocket/upgrade.js, on Hocuspocus's auth message.
//
//   doc name (isCollabDocName) → ticket present → verifyTicket (sig, iss, aud, type,
//   exp, doc === documentName) → burn the jti (TicketReplayGuard, before the lookup, so a
//   failed lookup can't be retried with the same ticket) → ticketIdentity → the API's
//   access lookup (3s timeout, X-Request-ID) → read-write / read-only / deny → epoch.
//
// Throwing rejects the connection: Hocuspocus sends `permission-denied` with our
// `reason`, and the client fetches a fresh ticket before it retries. The ticket arrives
// in the auth message (not the URL), is never logged, and never leaves this process.
// Users are logged by id only (#155).
//
// Dependencies are injected so the matrix is unit tested (auth.test.ts). Must NOT
// import yjs.
import type { IncomingHttpHeaders } from "node:http"
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
} as const

export class AuthRejection extends Error {
  constructor(readonly reason: string, message: string) {
    super(message)
    this.name = "AuthRejection"
  }
}

/** What onAuthenticate adds to the Hocuspocus connection context. */
export interface CollabContext {
  userId: string
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
    const reject = (reason: string, logReason: string, { warn = false, userId }: { warn?: boolean; userId?: string } = {}) => {
      logEvent(warn ? "warn" : "error", "ws_deny", {
        request_id: requestId,
        doc: docName,
        reason: logReason,
        sent: reason,
        user_id: userId,
        client: clientContextForLog(payload.requestHeaders, payload.request?.socket?.remoteAddress),
      })
      return new AuthRejection(reason, logReason)
    }

    if (!isCollabDocName(rawDocName)) {
      throw reject(DENY.forbidden, "Invalid document name", { warn: true })
    }
    const ticket = typeof payload.token === "string" ? payload.token.trim() : ""
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
    let access: DocAccess | null
    try {
      access = await deps.fetchAccess(identity, rawDocName, { requestId })
    } catch (error) {
      throw reject(DENY.unavailable, `Access lookup failed: ${errorMessage(error)}`, { userId: identity.userId })
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
        throw reject(DENY.unavailable, `Epoch check failed: ${errorMessage(error)}`, { userId: identity.userId })
      }
      if (epoch !== clientEpoch) {
        throw reject(DENY.staleEpoch, "Client epoch does not match the document", { warn: true, userId: identity.userId })
      }
    }

    const readOnly = mode === "read"
    payload.connectionConfig.readOnly = readOnly
    return { userId: identity.userId, role: access?.role ?? null, requestId, readOnly }
  }
}
