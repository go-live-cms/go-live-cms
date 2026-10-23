import { describe, it, expect, vi, afterEach } from "vitest"
import { TicketReplayGuard, verifyTicket, type DocAccess, type TicketClaims } from "./access"
import { AuthRejection, createAuthenticate, DENY, type AuthDeps, type AuthPayload } from "./auth"
import { ISSUER, ticketKeys } from "./testkit"

const { publicKey, sign } = await ticketKeys()

function payload(overrides: Partial<AuthPayload> = {}): AuthPayload {
  return {
    token: "",
    documentName: "post-12",
    requestHeaders: { "x-request-id": "req-abcdef12", origin: "http://localhost:4321" },
    requestParameters: new URLSearchParams(),
    connectionConfig: { readOnly: false },
    ...overrides,
  }
}

/** Real verification and replay guard; access and epoch stubbed. */
function deps(access: DocAccess | null | Error, overrides: Partial<AuthDeps> = {}) {
  const guard = new TicketReplayGuard()
  const fetchAccess = vi.fn(async () => {
    if (access instanceof Error) throw access
    return access
  })
  const all: AuthDeps = {
    verifyTicket: (ticket, docName) => verifyTicket(ticket, publicKey, { issuer: ISSUER, docName }),
    consumeTicket: (claims: TicketClaims) => guard.consume(claims),
    fetchAccess,
    currentEpoch: async () => "epoch-1",
    ...overrides,
  }
  return { all, fetchAccess, guard }
}

async function rejection(promise: Promise<unknown>): Promise<AuthRejection> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(AuthRejection)
  return error as AuthRejection
}

const iat = { iat: new Date().toISOString() }

describe("onAuthenticate", () => {
  const logs: string[] = []
  const spies = (["log", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((line: string) => void logs.push(String(line))),
  )
  afterEach(() => {
    logs.length = 0
  })

  it("an editor connects read-write, with the identity in the context", async () => {
    const { all, fetchAccess } = deps({ role: "editor", canEdit: true })
    const p = payload({ token: await sign(iat) })
    const context = await createAuthenticate(all)(p)
    expect(context).toEqual({ userId: "7", role: "editor", requestId: "req-abcdef12", readOnly: false })
    expect(p.connectionConfig.readOnly).toBe(false)
    expect(fetchAccess).toHaveBeenCalledWith({ userId: "7", issuedAt: expect.any(Number) }, "post-12", { requestId: "req-abcdef12" })
  })

  it("a contributor on someone else's post connects read-only", async () => {
    const { all } = deps({ role: "contributor", canEdit: false })
    const p = payload({ token: await sign(iat) })
    expect((await createAuthenticate(all)(p)).readOnly).toBe(true)
    expect(p.connectionConfig.readOnly).toBe(true)
  })

  it("a contributor on their own post connects read-write (#135)", async () => {
    const { all } = deps({ role: "contributor", canEdit: true })
    const p = payload({ token: await sign(iat) })
    expect((await createAuthenticate(all)(p)).readOnly).toBe(false)
  })

  it("denies a role that may not read posts, and a user or post the API doesn't know", async () => {
    for (const access of [{ role: "subscriber", canEdit: false }, null]) {
      const { all } = deps(access)
      const error = await rejection(createAuthenticate(all)(payload({ token: await sign(iat) })))
      expect(error.reason).toBe(DENY.forbidden)
    }
  })

  it("denies when the role lookup fails (API down), and burns the ticket anyway", async () => {
    const { all, guard } = deps(new Error("access lookup failed: API responded 502"))
    const token = await sign(iat)
    const error = await rejection(createAuthenticate(all)(payload({ token })))
    expect(error.reason).toBe(DENY.unavailable)
    expect(guard.size).toBe(1)
    // The same ticket can't be retried once the API is back; the client fetches a new one.
    const retry = await rejection(createAuthenticate(deps({ role: "editor", canEdit: true }, { consumeTicket: (c) => guard.consume(c) }).all)(payload({ token })))
    expect(retry.message).toBe("Ticket already used")
  })

  it("rejects a ticket for another doc before burning it or asking the API", async () => {
    const { all, fetchAccess, guard } = deps({ role: "editor", canEdit: true })
    const error = await rejection(createAuthenticate(all)(payload({ token: await sign({ ...iat, doc: "post-13" }) })))
    expect(error.reason).toBe(DENY.forbidden)
    expect(error.message).toMatch(/different document/)
    expect(guard.size).toBe(0)
    expect(fetchAccess).not.toHaveBeenCalled()
  })

  it("rejects a replayed ticket", async () => {
    const { all, fetchAccess } = deps({ role: "editor", canEdit: true })
    const token = await sign(iat)
    await createAuthenticate(all)(payload({ token }))
    const error = await rejection(createAuthenticate(all)(payload({ token })))
    expect(error.message).toBe("Ticket already used")
    expect(fetchAccess).toHaveBeenCalledTimes(1)
  })

  it("rejects bad doc names, missing and invalid tickets, and access tokens", async () => {
    const { all, fetchAccess } = deps({ role: "editor", canEdit: true })
    const auth = createAuthenticate(all)
    await rejection(auth(payload({ documentName: "post-1/../x", token: await sign(iat) })))
    await rejection(auth(payload({ token: "" })))
    await rejection(auth(payload({ token: "v4.public.junk" })))
    await rejection(auth(payload({ token: await sign(iat, { audience: "golive.admin" }) })))
    await rejection(auth(payload({ token: await sign(iat, { now: new Date(Date.now() - 120_000) }) })))
    expect(fetchAccess).not.toHaveBeenCalled()
  })

  it("rejects a ticket without a usable user_id or iat", async () => {
    const { all, fetchAccess } = deps({ role: "editor", canEdit: true })
    const error = await rejection(createAuthenticate(all)(payload({ token: await sign({ user_id: "0" }) })))
    expect(error.message).toMatch(/user_id\/iat/)
    expect(fetchAccess).not.toHaveBeenCalled()
  })

  it("checks the client's epoch only when it sends one, after access", async () => {
    const currentEpoch = vi.fn(async () => "epoch-1")
    const auth = createAuthenticate(deps({ role: "editor", canEdit: true }, { currentEpoch }).all)
    await auth(payload({ token: await sign(iat) }))
    expect(currentEpoch).not.toHaveBeenCalled()

    await auth(payload({ token: await sign(iat), requestParameters: new URLSearchParams({ epoch: "epoch-1" }) }))
    const stale = await rejection(auth(payload({ token: await sign(iat), requestParameters: new URLSearchParams({ epoch: "epoch-0" }) })))
    expect(stale.reason).toBe(DENY.staleEpoch)
    expect(currentEpoch).toHaveBeenCalledTimes(2)
  })

  it("never logs the ticket, and logs denials with the request id and client context", async () => {
    const { all } = deps({ role: "subscriber", canEdit: false })
    const token = await sign(iat)
    await rejection(createAuthenticate(all)(payload({ token })))
    await rejection(createAuthenticate(all)(payload({ token })))
    expect(logs.length).toBeGreaterThan(0)
    for (const line of logs) expect(line).not.toContain(token.slice(10, 60))
    const deny = JSON.parse(logs[0])
    expect(deny).toMatchObject({ event: "ws_deny", request_id: "req-abcdef12", doc: "post-12", user_id: "7" })
    expect(deny.client).toContain('origin="http://localhost:4321"')
  })

  it("spies are installed", () => expect(spies).toHaveLength(3))
})
