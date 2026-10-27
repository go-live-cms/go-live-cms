// The access re-check of open connections (#313), with fake connections, a manual
// clock and the #280 access contract in memory. server.recheck.test.ts runs the same
// cases against the real server and real clients.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { ACCESS_REVOKED, createAccessRecheck, type AccessRecheckOptions, type CheckedConnection } from "./recheck"
import { FakeClock, FakeCollabApi } from "./testkit"

const DOC = "post-12"
const MINUTE = 60_000
const ISSUED = 1_760_000_000

class FakeConnection implements CheckedConnection {
  messages: unknown[] = []
  closed: { code: number; reason: string } | null = null
  constructor(public readOnly = false) {}
  sendStateless(payload: string) {
    this.messages.push(JSON.parse(payload))
  }
  close(event?: { code: number; reason: string }) {
    this.closed = event ?? { code: 1000, reason: "" }
  }
}

let api: FakeCollabApi
let clock: FakeClock
let logs: string[]

function recheck(options: Partial<AccessRecheckOptions> = {}) {
  return createAccessRecheck({
    fetchAccess: (identity, docName) => api.fetchAccess(identity, docName),
    intervalMs: MINUTE,
    jitter: 0,
    retryMs: 10_000,
    graceMs: 2 * MINUTE,
    clock,
    ...options,
  })
}

const events = (name: string) => logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === name)

beforeEach(() => {
  api = new FakeCollabApi()
  api.users.set("2", { role: "editor" })
  api.users.set("3", { role: "contributor" })
  api.users.set("4", { role: "contributor", owns: ["12"] })
  clock = new FakeClock()
  logs = []
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((line: unknown) => void logs.push(String(line)))
  }
})

afterEach(() => vi.restoreAllMocks())

describe("access re-check (recheck.ts)", () => {
  it("makes a demoted user's connection read-only within one interval and tells the client", async () => {
    const checks = recheck()
    const conn = new FakeConnection()
    checks.add(conn, { userId: "2", issuedAt: ISSUED, docName: DOC })

    await clock.advance(MINUTE)
    expect(conn.readOnly).toBe(false)
    expect(conn.messages).toEqual([])

    api.users.set("2", { role: "contributor" }) // demoted; doesn't own post 12
    await clock.advance(MINUTE)
    expect(conn.readOnly).toBe(true)
    expect(conn.closed).toBeNull()
    expect(conn.messages).toEqual([{ type: "access", mode: "read", reason: "demoted" }])
    expect(events("ws_access_changed")).toEqual([
      expect.objectContaining({ doc: DOC, user_id: "2", from: "write", to: "read", reason: "demoted" }),
    ])

    // Still re-checked: once is enough to tell the client.
    await clock.advance(MINUTE)
    expect(conn.messages).toHaveLength(1)
    expect(checks.size).toBe(1)
  })

  it("locks a contributor's own post once it is published (#135)", async () => {
    const checks = recheck()
    const conn = new FakeConnection()
    checks.add(conn, { userId: "4", issuedAt: ISSUED, docName: DOC })
    api.users.set("4", { role: "contributor", owns: ["12"], published: ["12"] })
    await clock.advance(MINUTE)
    expect(conn.readOnly).toBe(true)
  })

  it("makes a re-promoted user read-write again", async () => {
    const checks = recheck()
    const conn = new FakeConnection(true) // a contributor on someone else's post
    checks.add(conn, { userId: "3", issuedAt: ISSUED, docName: DOC })
    api.users.set("3", { role: "editor" })
    await clock.advance(MINUTE)
    expect(conn.readOnly).toBe(false)
    expect(conn.messages).toEqual([{ type: "access", mode: "write", reason: "restored" }])
  })

  it("closes a deleted user's connection with access-revoked and stops checking it", async () => {
    const checks = recheck()
    const conn = new FakeConnection()
    checks.add(conn, { userId: "2", issuedAt: ISSUED, docName: DOC })
    api.users.delete("2")
    await clock.advance(MINUTE)
    expect(conn.closed).toEqual({ code: 4403, reason: ACCESS_REVOKED })
    expect(checks.size).toBe(0)
    expect(clock.pending).toBe(0)
    expect(events("ws_access_revoked")).toEqual([expect.objectContaining({ doc: DOC, user_id: "2", from: "write" })])
  })

  it("closes a user who lost every content role", async () => {
    const checks = recheck()
    const conn = new FakeConnection()
    checks.add(conn, { userId: "2", issuedAt: ISSUED, docName: DOC })
    api.users.set("2", { role: "subscriber" })
    await clock.advance(MINUTE)
    expect(conn.closed?.reason).toBe(ACCESS_REVOKED)
  })

  it("closes sessions opened before a password change, using the original ticket's iat", async () => {
    const lookups: number[] = []
    const checks = recheck({
      fetchAccess: (identity, docName) => {
        lookups.push(identity.issuedAt)
        return api.fetchAccess(identity, docName)
      },
    })
    const before = new FakeConnection()
    const after = new FakeConnection()
    checks.add(before, { userId: "2", issuedAt: ISSUED, docName: DOC })
    api.passwordChangedAt.set("2", ISSUED + 30)
    // Signed in again after the change, in another tab.
    checks.add(after, { userId: "2", issuedAt: ISSUED + 40, docName: DOC })

    await clock.advance(MINUTE)
    expect(before.closed?.reason).toBe(ACCESS_REVOKED)
    expect(after.closed).toBeNull()
    expect(after.readOnly).toBe(false)
    // Oldest ticket first, then the next one: one lookup per distinct iat at most.
    expect(lookups).toEqual([ISSUED, ISSUED + 40])

    lookups.length = 0
    await clock.advance(MINUTE)
    expect(lookups).toEqual([ISSUED + 40])
  })

  it("batches connections of one user on one doc into a single lookup", async () => {
    const spy = vi.spyOn(api, "fetchAccess")
    const checks = recheck()
    const a = new FakeConnection()
    const b = new FakeConnection()
    checks.add(a, { userId: "2", issuedAt: ISSUED, docName: DOC })
    checks.add(b, { userId: "2", issuedAt: ISSUED + 5, docName: DOC })
    checks.add(new FakeConnection(), { userId: "2", issuedAt: ISSUED, docName: "post-13" })
    await clock.advance(MINUTE)
    // One per (user, doc): the older iat passed, so the newer one needs no lookup.
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenCalledWith({ userId: "2", issuedAt: ISSUED }, DOC)
  })

  it("spreads checks with jitter", async () => {
    const at = async (random: number) => {
      const c = new FakeClock()
      const spy = vi.fn(async () => ({ role: "editor", canEdit: true }))
      createAccessRecheck({ fetchAccess: spy, intervalMs: MINUTE, jitter: 0.2, clock: c, random: () => random }).add(
        new FakeConnection(),
        { userId: "2", issuedAt: ISSUED, docName: DOC }
      )
      await c.advance(0.8 * MINUTE - 1)
      const early = spy.mock.calls.length
      await c.advance(0.4 * MINUTE + 1)
      return { early, total: spy.mock.calls.length }
    }
    expect(await at(0)).toEqual({ early: 0, total: 1 }) // 48s
    expect(await at(0.999)).toEqual({ early: 0, total: 1 }) // ~72s
  })

  it("keeps the mode through an API outage within the grace period, then makes it read-only, then restores it", async () => {
    const checks = recheck()
    const conn = new FakeConnection()
    checks.add(conn, { userId: "2", issuedAt: ISSUED, docName: DOC })
    await clock.advance(MINUTE) // healthy check

    api.failAccess = true
    const callsBefore = api.accessCalls
    await clock.advance(MINUTE) // first failure
    expect(conn.readOnly).toBe(false)
    expect(conn.closed).toBeNull()
    // Retried every 10s, not every minute, and still writable just inside the grace period.
    await clock.advance(2 * MINUTE - 10_000)
    expect(api.accessCalls - callsBefore).toBe(12)
    expect(conn.readOnly).toBe(false)
    expect(conn.closed).toBeNull()
    expect(conn.messages).toEqual([])
    expect(events("ws_access_check_failed")[0]).toEqual(
      expect.objectContaining({ doc: DOC, user_id: "2", error: "access lookup failed: API responded 502", grace_ms: 2 * MINUTE })
    )

    // Past the grace period: no more writes on an access nobody could confirm, but not closed.
    await clock.advance(10_000)
    expect(conn.readOnly).toBe(true)
    expect(conn.closed).toBeNull()
    expect(conn.messages).toEqual([{ type: "access", mode: "read", reason: "unverified" }])

    api.failAccess = false
    await clock.advance(10_000)
    expect(conn.readOnly).toBe(false)
    expect(conn.messages.at(-1)).toEqual({ type: "access", mode: "write", reason: "restored" })
  })

  it("tells an outage-downgraded client the real reason when the API comes back with read-only", async () => {
    const checks = recheck({ graceMs: 0 })
    const conn = new FakeConnection()
    checks.add(conn, { userId: "2", issuedAt: ISSUED, docName: DOC })
    api.failAccess = true
    await clock.advance(MINUTE)
    expect(conn.messages).toEqual([{ type: "access", mode: "read", reason: "unverified" }])
    api.failAccess = false
    api.users.set("2", { role: "contributor" })
    await clock.advance(10_000)
    expect(conn.readOnly).toBe(true)
    expect(conn.messages.at(-1)).toEqual({ type: "access", mode: "read", reason: "demoted" })
  })

  it("leaves a connection that was read-only all along alone during an outage", async () => {
    const checks = recheck({ graceMs: 0 })
    const conn = new FakeConnection(true)
    checks.add(conn, { userId: "3", issuedAt: ISSUED, docName: DOC })
    api.failAccess = true
    await clock.advance(MINUTE)
    api.failAccess = false
    await clock.advance(10_000)
    expect(conn.messages).toEqual([])
    expect(conn.readOnly).toBe(true)
  })

  it("stops checking closed connections, and can be turned off", async () => {
    const checks = recheck()
    const conn = new FakeConnection()
    checks.add(conn, { userId: "2", issuedAt: ISSUED, docName: DOC })
    checks.remove(conn)
    expect(clock.pending).toBe(0)
    await clock.advance(5 * MINUTE)
    expect(api.accessCalls).toBe(0)

    const off = recheck({ intervalMs: 0 })
    off.add(new FakeConnection(), { userId: "2", issuedAt: ISSUED, docName: DOC })
    expect(off.size).toBe(0)
    expect(clock.pending).toBe(0)
  })

  it("never logs a ticket or a secret", async () => {
    const checks = recheck()
    checks.add(new FakeConnection(), { userId: "2", issuedAt: ISSUED, docName: DOC })
    api.users.set("2", { role: "contributor" })
    await clock.advance(MINUTE)
    api.users.delete("2")
    await clock.advance(MINUTE)
    expect(logs.length).toBeGreaterThan(0)
    for (const line of logs) expect(line).not.toMatch(/ticket|token|secret|v4\.public/i)
  })
})
