// Ported from websocket/access.test.js (#216, #220, #223, #233, #135).
import { describe, it, expect } from "vitest"
import { createPublicKey, randomUUID } from "node:crypto"
import { V4 } from "paseto"
import {
  accessMode,
  fetchDocAccess,
  isCollabDocName,
  postIdOf,
  publicKeyFromHex,
  ticketIdentity,
  verifyTicket,
  TicketReplayGuard,
  TICKET_AUDIENCE,
  TICKET_CLOCK_TOLERANCE_MS,
  TICKET_TYPE,
} from "./access"
import { ISSUER, ticketKeys } from "./testkit"

/** Fake fetch that records the request and answers with the given status/body. */
function fakeFetch(status: number, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return { status, ok: status >= 200 && status < 300, json: async () => body }
  }) as unknown as typeof fetch
  return { impl, calls }
}

const { publicKey, publicKeyHex, sign } = await ticketKeys()

describe("doc names", () => {
  it("accepts only post-<positive id>", () => {
    for (const ok of ["post-1", "post-2892", "post-9223372036854775807"]) expect(isCollabDocName(ok), ok).toBe(true)
    for (const bad of ["", "post-", "post-0", "post-01", "post-1a", "Post-1", "post-1/x", "post-1 | x", "anything",
      "post-12345678901234567890", undefined, 1]) {
      expect(isCollabDocName(bad), String(bad)).toBe(false)
    }
  })

  it("postIdOf keeps the id as a string and refuses bad names", () => {
    expect(postIdOf("post-9223372036854775807")).toBe("9223372036854775807")
    expect(() => postIdOf("post-0")).toThrow()
  })
})

describe("publicKeyFromHex", () => {
  it("builds the same key as the PEM path", () => {
    const key = publicKeyFromHex(publicKeyHex)
    expect(key.export({ format: "jwk" })).toEqual(publicKey.export({ format: "jwk" }))
  })

  it("rejects anything but 64 hex characters", () => {
    for (const bad of ["", "abc", "z".repeat(64), "a".repeat(63), undefined]) expect(() => publicKeyFromHex(bad)).toThrow()
  })
})

describe("verifyTicket", () => {
  const opts = { issuer: ISSUER, docName: "post-12" }

  it("returns the claims of a valid ticket for this doc", async () => {
    const claims = await verifyTicket(await sign(), publicKey, opts)
    expect(claims).toMatchObject({ user_id: "7", doc: "post-12", token_type: TICKET_TYPE, aud: TICKET_AUDIENCE })
  })

  it("rejects a ticket minted for another document", async () => {
    await expect(verifyTicket(await sign({ doc: "post-13" }), publicKey, opts)).rejects.toThrow(/different document/)
  })

  it("rejects an access token (wrong audience) and a non-ticket token type", async () => {
    await expect(verifyTicket(await sign({}, { audience: "golive.admin" }), publicKey, opts)).rejects.toThrow()
    await expect(verifyTicket(await sign({ token_type: "access" }), publicKey, opts)).rejects.toThrow(/not a collab ticket/)
  })

  it("rejects an expired ticket, another key's signature and garbage", async () => {
    await expect(verifyTicket(await sign({}, { now: new Date(Date.now() - 120_000) }), publicKey, opts)).rejects.toThrow()
    const otherKey = (await V4.generateKey("public")) as import("node:crypto").KeyObject
    await expect(verifyTicket(await sign({}, { key: otherKey }), publicKey, opts)).rejects.toThrow()
    await expect(verifyTicket("v4.public.garbage", publicKey, opts)).rejects.toThrow()
  })

  it("rejects a ticket without a jti", async () => {
    const privateKey = (await V4.generateKey("public")) as import("node:crypto").KeyObject
    const noJti = await V4.sign({ user_id: "7", token_type: TICKET_TYPE, doc: "post-12" }, privateKey, {
      issuer: ISSUER,
      audience: TICKET_AUDIENCE,
      expiresIn: "30s",
    })
    await expect(verifyTicket(noJti, createPublicKey(privateKey), opts)).rejects.toThrow(/jti/)
  })
})

describe("TicketReplayGuard", () => {
  const exp = (ms: number) => new Date(ms).toISOString()

  it("lets a ticket through once", () => {
    const guard = new TicketReplayGuard()
    const claims = { jti: randomUUID(), exp: exp(Date.now() + 30_000) }
    expect(guard.consume(claims)).toBe(true)
    expect(guard.consume(claims)).toBe(false)
    expect(guard.consume({ jti: randomUUID(), exp: claims.exp })).toBe(true)
  })

  it("forgets a jti only after it can no longer verify (exp + tolerance)", () => {
    const guard = new TicketReplayGuard()
    const now = 1_000_000
    const claims = { jti: "a", exp: exp(now) }
    expect(guard.consume(claims, now)).toBe(true)
    expect(guard.consume(claims, now + TICKET_CLOCK_TOLERANCE_MS)).toBe(false)
    guard.consume({ jti: "b", exp: exp(now + 60_000) }, now + TICKET_CLOCK_TOLERANCE_MS + 1)
    expect(guard.size).toBe(1)
  })
})

describe("ticketIdentity", () => {
  const iat = "2026-10-01T00:00:00Z"

  it("returns the user id and iat in Unix seconds", () => {
    expect(ticketIdentity({ user_id: "42", iat })).toEqual({ userId: "42", issuedAt: Date.parse(iat) / 1000 })
    expect(ticketIdentity({ user_id: 42, iat })?.userId).toBe("42")
  })

  it("returns null for a missing or malformed user_id or iat", () => {
    for (const bad of [{ iat }, { user_id: "0", iat }, { user_id: "-1", iat }, { user_id: "7x", iat }, { user_id: "7" },
      { user_id: "7", iat: "yesterday" }, null]) {
      expect(ticketIdentity(bad as never)).toBeNull()
    }
  })
})

describe("fetchDocAccess", () => {
  const identity = { userId: "7", issuedAt: 1760000000 }

  it("asks the internal endpoint with the shared secret and forwards the request id", async () => {
    const { impl, calls } = fakeFetch(200, { role: "editor", can_edit: true })
    const access = await fetchDocAccess("http://api:8081/", identity, "post-12", "s3cret", { fetchImpl: impl, requestId: "req-12345678" })
    expect(access).toEqual({ role: "editor", canEdit: true })
    expect(calls[0].url).toBe("http://api:8081/internal/users/7/access?doc=post-12&issued_at=1760000000")
    expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer s3cret", "X-Request-ID": "req-12345678" })
  })

  it("treats anything but a literal true as no edit right", async () => {
    const { impl } = fakeFetch(200, { role: "contributor", can_edit: "true" })
    expect(await fetchDocAccess("http://api", identity, "post-12", "s", { fetchImpl: impl })).toEqual({ role: "contributor", canEdit: false })
  })

  it("returns null on 403/404 and throws on 401, 5xx and network errors", async () => {
    for (const status of [403, 404]) {
      expect(await fetchDocAccess("http://api", identity, "post-12", "s", { fetchImpl: fakeFetch(status).impl })).toBeNull()
    }
    await expect(fetchDocAccess("http://api", identity, "post-12", "s", { fetchImpl: fakeFetch(401).impl })).rejects.toThrow(/ROLE_LOOKUP_SECRET/)
    await expect(fetchDocAccess("http://api", identity, "post-12", "s", { fetchImpl: fakeFetch(502).impl })).rejects.toThrow(/502/)
    const down = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    await expect(fetchDocAccess("http://api", identity, "post-12", "s", { fetchImpl: down })).rejects.toThrow()
  })
})

describe("accessMode", () => {
  it("editors and owners write, other content roles read, everyone else is denied", () => {
    expect(accessMode({ role: "admin", canEdit: true })).toBe("write")
    expect(accessMode({ role: "editor", canEdit: true })).toBe("write")
    expect(accessMode({ role: "contributor", canEdit: true })).toBe("write")
    expect(accessMode({ role: "contributor", canEdit: false })).toBe("read")
    expect(accessMode({ role: "subscriber", canEdit: false })).toBeNull()
    expect(accessMode({ role: null, canEdit: false })).toBeNull()
    expect(accessMode(null)).toBeNull()
  })
})
