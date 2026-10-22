import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, apiCall } from "./api"
import { authManager } from "./auth"
import { updateUser } from "./api/users"
import {
  adoptPasswordChangeSession,
  buildProfileUpdate,
  describePasswordChangeError,
  describeProfileError,
  validatePasswordChange,
  validateProfile,
} from "./profile"

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

const PROFILE = { username: "editor", email: "editor@example.com", full_name: "Ed Itor" }

describe("validateProfile", () => {
  it("accepts a valid profile", () => {
    expect(validateProfile(PROFILE)).toBeNull()
  })

  it("enforces the API's username, email and full name limits", () => {
    expect(validateProfile({ ...PROFILE, username: "ab" })).toMatch(/Username/)
    expect(validateProfile({ ...PROFILE, username: "a".repeat(51) })).toMatch(/Username/)
    expect(validateProfile({ ...PROFILE, username: "  abc  " })).toBeNull()
    expect(validateProfile({ ...PROFILE, email: "not-an-email" })).toMatch(/email/)
    expect(validateProfile({ ...PROFILE, full_name: "A" })).toMatch(/Full name/)
    expect(validateProfile({ ...PROFILE, full_name: "   " })).toMatch(/Full name/)
    expect(validateProfile({ ...PROFILE, full_name: "a".repeat(101) })).toMatch(/Full name/)
  })

  it("counts characters like Go's validator (runes, not UTF-16 units)", () => {
    // 50 emoji are 100 UTF-16 units but 50 runes: allowed by min=3,max=50.
    expect(validateProfile({ ...PROFILE, username: "😀".repeat(50) })).toBeNull()
  })
})

describe("buildProfileUpdate", () => {
  it("sends only changed, trimmed fields and never role or passwords", () => {
    const update = buildProfileUpdate(PROFILE, { ...PROFILE, full_name: "  New Name " })
    expect(update).toEqual({ full_name: "New Name" })
  })

  it("is empty when nothing changed", () => {
    expect(buildProfileUpdate(PROFILE, { ...PROFILE, username: " editor " })).toEqual({})
  })
})

describe("authManager.login", () => {
  afterEach(() => vi.unstubAllGlobals())

  // The login page maps these to "Incorrect username or password." and the
  // rate-limit message; ApiError's message no longer contains the status.
  it("returns the API's status on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(429, { error: "too many requests, try again later" })))
    await expect(authManager.login("u", "p")).resolves.toMatchObject({ success: false, status: 429 })
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { error: "invalid credentials" })))
    await expect(authManager.login("u", "p")).resolves.toMatchObject({ success: false, status: 401 })
  })
})

describe("authManager.setUser", () => {
  it("stores the user and notifies subscribers without another request", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const seen: string[] = []
    const unsubscribe = authManager.subscribe((s) => seen.push(s.user?.full_name))
    authManager.setUser({ id: 7, full_name: "New Name" })
    unsubscribe()
    vi.unstubAllGlobals()

    expect(seen).toEqual(["New Name"])
    expect(JSON.parse(localStorage.getItem("gl-auth-user")!).full_name).toBe("New Name")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("validatePasswordChange", () => {
  const ok = { current_password: "password123", password: "newpass1", confirm_password: "newpass1" }

  it("accepts a valid change", () => {
    expect(validatePasswordChange(ok)).toBeNull()
  })

  it("requires the current password", () => {
    expect(validatePasswordChange({ ...ok, current_password: "" })).toMatch(/current password/)
  })

  it("matches the API's min=6 rule", () => {
    expect(validatePasswordChange({ ...ok, password: "12345", confirm_password: "12345" })).toMatch(/at least 6/)
    expect(validatePasswordChange({ ...ok, password: "123456", confirm_password: "123456" })).toBeNull()
  })

  it("requires the confirmation to match, without trimming", () => {
    expect(validatePasswordChange({ ...ok, confirm_password: "newpass2" })).toMatch(/do not match/)
    expect(validatePasswordChange({ ...ok, confirm_password: "newpass1 " })).toMatch(/do not match/)
  })

  it("rejects reusing the current password", () => {
    expect(validatePasswordChange({ ...ok, password: "password123", confirm_password: "password123" })).toMatch(
      /different/
    )
  })
})

describe("error messages", () => {
  it("explains a wrong or missing current password by the API's code, not its wording", () => {
    expect(describePasswordChangeError(new ApiError("reworded", 403, null, "current_password_incorrect"))).toBe(
      "Your current password is incorrect."
    )
    expect(describePasswordChangeError(new ApiError("reworded", 403, null, "current_password_required"))).toBe(
      "Enter your current password."
    )
    expect(describePasswordChangeError(new ApiError("forbidden", 403))).toBe("forbidden")
  })

  it("explains the password-change rate limit with Retry-After", () => {
    expect(describePasswordChangeError(new ApiError("too many requests", 429, 42))).toBe(
      "Too many password change attempts. Try again in 42 seconds."
    )
    expect(describePasswordChangeError(new ApiError("too many requests", 429))).toMatch(/wait a minute/)
    // Retry-After: 0 is a real value (retry now), not a missing header.
    expect(describePasswordChangeError(new ApiError("too many requests", 429, 0))).toBe(
      "Too many password change attempts. Please try again."
    )
  })

  it("explains a taken username or email", () => {
    expect(describeProfileError(new ApiError("username or email already exists", 409))).toMatch(/already taken/)
  })
})

describe("apiCall errors", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    authManager.adoptAccessToken({ access_token: "tok", expires_at: Math.floor(Date.now() / 1000) + 900 })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("throws an ApiError carrying a readable message, the API's message, status and Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(429, { error: "too many requests" }, { "Retry-After": "17" }))
    )
    const err = await apiCall("/users/1", { method: "PUT", body: {} }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    // message is the readable text (lib/api/errors.ts); the API's own is serverMessage.
    expect(err.serverMessage).toBe("too many requests")
    expect(err.message).toBe("You're doing that too often. Please wait 17 seconds and try again.")
    expect(err.status).toBe(429)
    expect(err.retryAfterSeconds).toBe(17)
  })

  it("carries the API's error code, so a wrong current password is recognised", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(403, { error: "current password is incorrect", code: "current_password_incorrect" }))
    )
    const err = await apiCall("/users/1", { method: "PUT", body: {} }).catch((e) => e)
    expect(err.code).toBe("current_password_incorrect")
    expect(describePasswordChangeError(err)).toBe("Your current password is incorrect.")
  })
})

describe("after a password change", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("keeps this tab signed in on the token the API returns", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    authManager.adoptAccessToken({ access_token: "old-token", expires_at: Math.floor(Date.now() / 1000) + 900 })
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization
      if (url === "/api/v1/users/7" && init.method === "PUT") {
        return json(200, {
          user: { id: 7, username: "editor" },
          access_token: "new-token",
          access_token_expires_at: expiresAt.toISOString(),
          expires_at: Math.floor(expiresAt.getTime() / 1000),
        })
      }
      // Every token issued before the change is now revoked.
      if (url === "/api/v1/users/me") {
        return auth === "Bearer new-token" ? json(200, { user: { id: 7 } }) : json(401, { error: "revoked" })
      }
      return json(500, { error: `unexpected ${url}` })
    })
    vi.stubGlobal("fetch", fetchMock)

    const response = await updateUser(7, { password: "newpass1", current_password: "password123" } as any)
    expect(adoptPasswordChangeSession(authManager, response)).toBe("signed-in")

    const state = authManager.getState()
    expect(state.isAuthenticated).toBe(true)
    expect(state.accessToken).toBe("new-token")
    expect(state.tokenExpiry).toBe(expiresAt.getTime())
    expect(localStorage.getItem("access_token")).toBeNull()

    // The next request uses the new token directly: no 401, no refresh.
    await expect(apiCall("/users/me")).resolves.toEqual({ user: { id: 7 } })
    const urls = fetchMock.mock.calls.map((c) => c[0])
    expect(urls).toEqual(["/api/v1/users/7", "/api/v1/users/me"])
  })

  it("keeps the adopted token when a refresh already in flight fails on the old session", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    authManager.adoptAccessToken({ access_token: "old-token", expires_at: Math.floor(Date.now() / 1000) + 900 })
    let failRefresh!: () => void
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (url: string) =>
          new Promise<Response>((resolve) => {
            // The refresh presented the old cookie; the password change has
            // since blocked that session.
            if (url === "/api/v1/auth/refresh") failRefresh = () => resolve(json(401, { error: "session is blocked" }))
          })
      )
    )

    const refreshing = authManager.forceRefresh()
    adoptPasswordChangeSession(authManager, { access_token: "new-token", expires_at: Math.floor(Date.now() / 1000) + 900 })
    failRefresh()

    await expect(refreshing).resolves.toBe(true)
    expect(authManager.getState().isAuthenticated).toBe(true)
    expect(authManager.getAccessToken()).toBe("new-token")
  })

  it("asks to sign in again when the API couldn't start a new session", () => {
    const auth = { adoptAccessToken: vi.fn() }
    expect(adoptPasswordChangeSession(auth, { user: { id: 7 } } as any)).toBe("reauth")
    expect(adoptPasswordChangeSession(auth, null)).toBe("reauth")
    expect(auth.adoptAccessToken).not.toHaveBeenCalled()
  })
})
