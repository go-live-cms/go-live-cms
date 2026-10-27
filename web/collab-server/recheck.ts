// Periodic access re-check for open connections (#313). onAuthenticate asks the API once,
// at connect; without this, a session keeps what it was granted until it reconnects:
// a demoted user keeps writing, a deleted user keeps an open session, and a session
// opened before a password change or reset (#217/#222, #148) keeps editing.
//
// Every open connection is re-checked through the same lookup
// (GET /internal/users/:id/access), on a timer per (user, doc): every `intervalMs`,
// with ±`jitter`, so connections that opened together (everyone reconnecting after a
// restart) don't hit the API together. The lookup sends the ORIGINAL ticket's `iat`,
// so the API refuses a session opened before the user's latest password change.
//
//   - write → read (`can_edit` false, still a content role: demoted, or a contributor's
//     post was published, #135) → `connection.readOnly = true`; Hocuspocus drops that
//     connection's updates from then on. The client is told (`AccessMessage`).
//   - read → write (promoted again) → read-write again, client told.
//   - denied (403/404: user deleted, post deleted, ticket predates a password change;
//     or no content role any more) → the connection is closed with `access-revoked`.
//   - lookup failed (API down, slow, 5xx) → the connection KEEPS its mode, the failure
//     is logged and retried after `retryMs`. Fail-open for `graceMs` only: an API blip
//     must not disconnect every editor, but an outage can't extend a revoked session's
//     write access indefinitely either. Past the grace period a writable connection is
//     made read-only (`unverified`, never closed: the client keeps its state and goes
//     back to read-write on the next successful check).
//
// Pure + dependency-injected (lookup, clock, random); unit tested in recheck.test.ts.
// Must NOT import yjs.
import { accessMode, type DocAccess, type TicketIdentity } from "./access"
import { docNameForLog, errorMessage, logEvent, requestIdFrom } from "./logsafe"

/** The close reason a client sees when its access is gone (shown as "session ended"). */
export const ACCESS_REVOKED = "access-revoked"

/** Sent to one connection (sendStateless) when the server changes its mode. */
export interface AccessMessage {
  type: "access"
  mode: "read" | "write"
  /** demoted: the API says read-only; unverified: the API hasn't answered for the grace period; restored: read-write again. */
  reason: "demoted" | "unverified" | "restored"
}

export interface Clock {
  now(): number
  /** The callback may return a promise; a fake clock awaits it. */
  setTimeout(callback: () => unknown, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

/** The parts of a Hocuspocus Connection the re-check uses. */
export interface CheckedConnection {
  readOnly: boolean
  sendStateless(payload: string): void
  close(event?: { code: number; reason: string }): void
}

export interface AccessRecheckOptions {
  fetchAccess(identity: TicketIdentity, docName: string, opts: { requestId: string }): Promise<DocAccess | null>
  /** Between checks of one (user, doc). Default 60s. 0 disables the re-check. */
  intervalMs?: number
  /** ± fraction of the interval (0.2 → 48–72s for 60s). */
  jitter?: number
  /** After a failed lookup. Default 10s (never more than the interval). */
  retryMs?: number
  /** How long failed lookups may keep a connection writable. Default 120s. */
  graceMs?: number
  clock?: Clock
  random?: () => number
}

interface Group {
  userId: string
  docName: string
  /** Each connection with the `iat` (Unix seconds) of the ticket it opened with. */
  connections: Map<CheckedConnection, number>
  timer: unknown
  /** When lookups started failing (null while they succeed). */
  failingSince: number | null
  /** Made read-only because lookups kept failing (not because the API said so). */
  unverified: Set<CheckedConnection>
}

const CLOSE_CODE = 4403

export function createAccessRecheck(options: AccessRecheckOptions) {
  const {
    fetchAccess,
    intervalMs = 60_000,
    jitter = 0.2,
    graceMs = 120_000,
    clock = systemClock,
    random = Math.random,
  } = options
  const retryMs = Math.min(options.retryMs ?? 10_000, intervalMs || Infinity)
  const groups = new Map<string, Group>()
  let stopped = false

  const keyOf = (userId: string, docName: string) => `${userId}\u0000${docName}`
  const jittered = (ms: number) => Math.max(1, Math.round(ms * (1 - jitter + 2 * jitter * random())))

  function schedule(group: Group, ms: number) {
    if (stopped) return
    group.timer = clock.setTimeout(() => check(group), jittered(ms))
  }

  const live = (group: Group) => !stopped && groups.get(keyOf(group.userId, group.docName)) === group

  /**
   * Looks each distinct ticket age up, oldest first. Only `issued_at` differs between
   * them, and the API compares it with the password change alone, so once one is
   * allowed every newer one is too: usually a single lookup per (user, doc).
   */
  async function lookUp(group: Group, requestId: string): Promise<Map<number, DocAccess | null>> {
    const ages = [...new Set(group.connections.values())].sort((a, b) => a - b)
    const results = new Map<number, DocAccess | null>()
    for (const [i, issuedAt] of ages.entries()) {
      const access = await fetchAccess({ userId: group.userId, issuedAt }, group.docName, { requestId })
      if (access) {
        for (const later of ages.slice(i)) results.set(later, access)
        break
      }
      results.set(issuedAt, null)
    }
    return results
  }

  function setMode(group: Group, connection: CheckedConnection, mode: "read" | "write", reason: AccessMessage["reason"], requestId: string) {
    const from = connection.readOnly ? "read" : "write"
    if (reason === "unverified") {
      if (from === "read") return
      group.unverified.add(connection)
    } else {
      // Read-only for the outage, and the API now says read-only too: same mode, but the
      // client's notice should say why.
      const wasUnverified = group.unverified.delete(connection)
      if (from === mode && !wasUnverified) return
    }
    connection.readOnly = mode === "read"
    logEvent(reason === "restored" ? "info" : "warn", "ws_access_changed", {
      request_id: requestId,
      doc: docNameForLog(group.docName),
      user_id: group.userId,
      from,
      to: mode,
      reason,
    })
    const message: AccessMessage = { type: "access", mode, reason }
    try {
      connection.sendStateless(JSON.stringify(message))
    } catch {
      // Closing anyway; the mode is what protects the doc.
    }
  }

  async function check(group: Group) {
    group.timer = null
    if (!live(group)) return
    const requestId = requestIdFrom(undefined)
    let results: Map<number, DocAccess | null>
    try {
      results = await lookUp(group, requestId)
    } catch (error) {
      if (!live(group)) return
      const now = clock.now()
      group.failingSince ??= now
      const failingMs = now - group.failingSince
      logEvent("warn", "ws_access_check_failed", {
        request_id: requestId,
        doc: docNameForLog(group.docName),
        user_id: group.userId,
        error: errorMessage(error),
        failing_ms: failingMs,
        grace_ms: graceMs,
      })
      if (failingMs >= graceMs) {
        for (const connection of group.connections.keys()) setMode(group, connection, "read", "unverified", requestId)
      }
      schedule(group, retryMs)
      return
    }
    if (!live(group)) return
    group.failingSince = null

    for (const [connection, issuedAt] of [...group.connections]) {
      // Opened while the lookup was in flight (with a newer ticket): checked next time.
      if (!results.has(issuedAt)) continue
      const access = results.get(issuedAt) ?? null
      const mode = accessMode(access)
      if (!mode) {
        logEvent("warn", "ws_access_revoked", {
          request_id: requestId,
          doc: docNameForLog(group.docName),
          user_id: group.userId,
          from: connection.readOnly ? "read" : "write",
          role: access?.role ?? undefined,
        })
        remove(connection)
        connection.close({ code: CLOSE_CODE, reason: ACCESS_REVOKED })
        continue
      }
      // A connection made read-only by an outage goes back to what the API says now.
      setMode(group, connection, mode, mode === "read" ? "demoted" : "restored", requestId)
    }
    if (live(group) && group.connections.size > 0) schedule(group, intervalMs)
  }

  function remove(connection: CheckedConnection) {
    for (const [key, group] of groups) {
      if (!group.connections.delete(connection)) continue
      group.unverified.delete(connection)
      if (group.connections.size === 0) {
        if (group.timer) clock.clearTimeout(group.timer)
        groups.delete(key)
      }
      return
    }
  }

  return {
    /** Starts re-checking an authenticated connection; call `remove` when it closes. */
    add(connection: CheckedConnection, { userId, issuedAt, docName }: { userId: string; issuedAt: number; docName: string }) {
      if (stopped || !intervalMs) return
      const key = keyOf(userId, docName)
      let group = groups.get(key)
      if (!group) {
        group = { userId, docName, connections: new Map(), timer: null, failingSince: null, unverified: new Set() }
        groups.set(key, group)
        schedule(group, intervalMs)
      }
      group.connections.set(connection, issuedAt)
    },
    remove,
    /** Open connections being re-checked (tests). */
    get size(): number {
      let n = 0
      for (const group of groups.values()) n += group.connections.size
      return n
    },
    stop() {
      stopped = true
      for (const group of groups.values()) if (group.timer) clock.clearTimeout(group.timer)
      groups.clear()
    },
  }
}

export type AccessRecheck = ReturnType<typeof createAccessRecheck>
