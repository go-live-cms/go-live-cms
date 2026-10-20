import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { apiCall } from "./api"
import { authManager } from "./auth"

// A server-side revocation (e.g. the token predates a password change) shows
// up only as a 401 on a token the client still thinks is fresh. apiCall must
// refresh anyway and retry once, instead of waiting for the local expiry.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const FRESH_LOOKING = { access_token: "stale-token", expires_at: Math.floor(Date.now() / 1000) + 15 * 60 }

describe("apiCall 401 handling", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    authManager.adoptAccessToken(FRESH_LOOKING)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const authHeader = (call: unknown[]) => ((call[1] as RequestInit).headers as Record<string, string>).Authorization

  it("force-refreshes a not-yet-expired token on 401 and retries once with the new token", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === "/api/v1/auth/refresh") return json(200, { access_token: "new-token", expires_at: FRESH_LOOKING.expires_at })
      const auth = (init.headers as Record<string, string>).Authorization
      return auth === "Bearer new-token"
        ? json(200, { user: { id: 1 } })
        : json(401, { error: "token was issued before the latest password change" })
    })

    // A caller-supplied stale token must not be reused on the retry.
    await expect(apiCall("/users/me", { token: "stale-token" })).resolves.toEqual({ user: { id: 1 } })

    const urls = fetchMock.mock.calls.map((c) => c[0])
    expect(urls).toEqual(["/api/v1/users/me", "/api/v1/auth/refresh", "/api/v1/users/me"])
    expect(authHeader(fetchMock.mock.calls[2])).toBe("Bearer new-token")
    expect(authManager.getAccessToken()).toBe("new-token")
  })

  it("gives up after one retry and clears auth when the refresh session is revoked too", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/v1/auth/refresh" ? json(401, { error: "session is blocked" }) : json(401, { error: "token revoked" })
    )

    await expect(apiCall("/users/me")).rejects.toThrow(/HTTP 401/)
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/v1/users/me", "/api/v1/auth/refresh"])
    expect(authManager.getState().isAuthenticated).toBe(false)
  })

  it("retries without refreshing when another request already swapped in a new token", async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization
      if (auth === "Bearer stale-token") {
        // Simulate a concurrent refresh landing while this request was in flight.
        authManager.adoptAccessToken({ access_token: "new-token", expires_at: FRESH_LOOKING.expires_at })
        return json(401, { error: "token revoked" })
      }
      return json(200, { ok: true })
    })

    await expect(apiCall("/users/me")).resolves.toEqual({ ok: true })
    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain("/api/v1/auth/refresh")
  })

  it("does not refresh on auth endpoints, where 401 means bad credentials", async () => {
    fetchMock.mockResolvedValue(json(401, { error: "invalid credentials" }))

    await expect(apiCall("/auth/login", { method: "POST", body: { username: "a", password: "b" } })).rejects.toThrow(
      /HTTP 401/
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
