import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, apiCall } from "./api"
import { authManager } from "./auth"
import { updateUser } from "./api/users"
import {
  AVATAR_MAX_BYTES,
  avatarCropPosition,
  BIO_MAX,
  adoptPasswordChangeSession,
  describeAvatarError,
  describeEmailChangeError,
  describeSignOutError,
  emailChangeSentMessage,
  otherDevicesSummary,
  signedOutMessage,
  validateAvatarFile,
  validateEmailChange,
  authorFieldErrors,
  buildProfileUpdate,
  isValidWebsite,
  normalizeBio,
  describePasswordChangeError,
  describeProfileError,
  newPasswordChecklist,
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

// Bio and website (#350): the same rules as the API's normalizeBio/normalizeWebsite.
describe("author profile fields", () => {
  it("accepts a bio up to 300 characters, counted like the API (code points)", () => {
    expect(authorFieldErrors({ bio: "a".repeat(BIO_MAX) })).toEqual({})
    expect(authorFieldErrors({ bio: "😀".repeat(BIO_MAX) })).toEqual({})
    expect(authorFieldErrors({ bio: `  ${"a".repeat(BIO_MAX)}  ` })).toEqual({})
    expect(authorFieldErrors({ bio: "a".repeat(BIO_MAX + 1) }).bio).toMatch(/300 characters/)
    expect(validateProfile({ ...PROFILE, bio: "a".repeat(BIO_MAX + 1) })).toMatch(/300 characters/)
  })

  it("keeps a bio plain text: line breaks and tabs, no other control characters", () => {
    expect(authorFieldErrors({ bio: "Line one\nLine two\tend" })).toEqual({})
    expect(authorFieldErrors({ bio: "bell\u0007" }).bio).toMatch(/plain text/)
  })

  it("takes only an http(s) URL with a host as the website, or nothing", () => {
    for (const ok of ["", "  ", "https://anacosta.example", "http://a.example/about?x=1"]) {
      expect(authorFieldErrors({ website: ok })).toEqual({})
    }
    for (const bad of ["anacosta.example", "javascript:alert(1)", "ftp://a.example", "https://", "mailto:a@b.c"]) {
      expect(authorFieldErrors({ website: bad }).website).toMatch(/http:\/\/ or https:\/\//)
    }
    expect(validateProfile({ ...PROFILE, website: "nope" })).toMatch(/web address/)
    expect(isValidWebsite(`https://a.example/${"a".repeat(2048)}`)).toBe(false)
  })

  it("sends a changed bio and website trimmed, and an emptied one as '' to clear it", () => {
    const original = { ...PROFILE, bio: "Old", website: "https://old.example" }
    expect(buildProfileUpdate(original, { ...original, bio: " New\r\nbio ", website: " https://new.example " })).toEqual({
      bio: "New\nbio",
      website: "https://new.example",
    })
    expect(buildProfileUpdate(original, { ...original, bio: "", website: "" })).toEqual({ bio: "", website: "" })
    expect(buildProfileUpdate(original, { ...original, bio: " Old " })).toEqual({})
    expect(normalizeBio(undefined)).toBe("")
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
  // The current one may be shorter than the new minimum: it was set before #329.
  const ok = { current_password: "old-pass", password: "new-password", confirm_password: "new-password" }

  it("accepts a valid change", () => {
    expect(validatePasswordChange(ok)).toBeNull()
  })

  it("requires the current password", () => {
    expect(validatePasswordChange({ ...ok, current_password: "" })).toMatch(/current password/)
  })

  it("matches the API's 12-character minimum", () => {
    expect(validatePasswordChange({ ...ok, password: "new-passwor", confirm_password: "new-passwor" })).toMatch(/at least 12/)
    expect(validatePasswordChange({ ...ok, password: "new-passwor1", confirm_password: "new-passwor1" })).toBeNull()
  })

  it("refuses the account's email, username or name", () => {
    const details = ["marisol@example.com", "marisolduarte", "Marisol Duarte"]
    const change = (password: string) => validatePasswordChange({ ...ok, password, confirm_password: password }, details)
    expect(change("Marisol@Example.com")).toMatch(/can't be your email, username or name/)
    expect(change("MARISOLDUARTE")).toMatch(/can't be your email, username or name/)
    expect(change("marisol duarte")).toMatch(/can't be your email, username or name/)
    expect(change("new-password")).toBeNull()
  })

  it("requires the confirmation to match, without trimming", () => {
    expect(validatePasswordChange({ ...ok, confirm_password: "new-password2" })).toMatch(/do not match/)
    expect(validatePasswordChange({ ...ok, confirm_password: "new-password " })).toMatch(/do not match/)
  })

  it("rejects reusing the current password", () => {
    const current = { ...ok, current_password: "password-1234" }
    expect(validatePasswordChange({ ...current, password: "password-1234", confirm_password: "password-1234" })).toMatch(
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

    const response = await updateUser(7, { password: "new-password-1", current_password: "old-pass" } as any)
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

describe("newPasswordChecklist (Profile's new-password checklist)", () => {
  it("shows the API's minimum, 12 (#329)", () => {
    expect(newPasswordChecklist("abcdefghijk")[0]).toEqual({ label: "At least 12 characters (11 so far)", met: false })
    expect(newPasswordChecklist("abcdefghijkl")[0]).toEqual({ label: "At least 12 characters", met: true })
  })

  it("counts characters as the API does (runes, not UTF-16 units)", () => {
    // Eleven emoji are 22 UTF-16 units.
    expect(newPasswordChecklist("😀".repeat(11))[0].met).toBe(false)
    expect(newPasswordChecklist("😀".repeat(12))[0].met).toBe(true)
  })

  it("adds the different-from-current rule only when there is a current password field", () => {
    expect(newPasswordChecklist("abcdef")).toHaveLength(1)
    expect(newPasswordChecklist("abcdef", "abcdef")[1]).toEqual({ label: "Different from your current password", met: false })
    expect(newPasswordChecklist("abcdefg", "abcdef")[1].met).toBe(true)
    expect(newPasswordChecklist("", "")[1].met).toBe(false)
  })

  it("adds the design's \"Not your email or name\" when the account's details are given", () => {
    const details = ["marisol@example.com", "marisolduarte", "Marisol Duarte"]
    const labels = (password: string) => newPasswordChecklist(password, "old-pass", details).map((r) => r.label)
    expect(labels("x")).toEqual(["At least 12 characters (1 so far)", "Not your email or name", "Different from your current password"])
    expect(newPasswordChecklist("", "old-pass", details)[1].met).toBe(false)
    expect(newPasswordChecklist("MARISOL@example.com", "old-pass", details)[1].met).toBe(false)
    expect(newPasswordChecklist("marisol duarte", "old-pass", details)[1].met).toBe(false)
    expect(newPasswordChecklist("a-new-password", "old-pass", details)[1].met).toBe(true)
  })
})

describe("profile photo checks (#334)", () => {
  it("takes the API's types and size", () => {
    for (const type of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
      expect(validateAvatarFile({ type, size: 1000 })).toBeNull()
    }
    expect(validateAvatarFile({ type: "image/svg+xml", size: 10 })).toMatch(/JPEG, PNG, GIF or WebP/)
    expect(validateAvatarFile({ type: "", size: 10 })).toMatch(/JPEG/)
    expect(validateAvatarFile({ type: "image/png", size: AVATAR_MAX_BYTES })).toBeNull()
    expect(validateAvatarFile({ type: "image/png", size: AVATAR_MAX_BYTES + 1 })).toMatch(/5 MB/)
  })

  it("matches the API's limit (api/avatar_utils.go)", async () => {
    const { readFileSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const go = readFileSync(resolve(__dirname, "../../../api/avatar_utils.go"), "utf8")
    expect(go).toMatch(/avatarMaxBytes int64 = 5 << 20/)
    expect(AVATAR_MAX_BYTES).toBe(5 << 20)
  })

  it("explains the API's refusals", () => {
    expect(describeAvatarError(new ApiError("x", 400, null, "avatar_type"))).toMatch(/JPEG/)
    expect(describeAvatarError(new ApiError("x", 400, null, "avatar_unreadable"))).toMatch(/can read/)
    expect(describeAvatarError(new ApiError("x", 400, null, "avatar_dimensions"))).toMatch(/too big/)
    expect(describeAvatarError(new ApiError("x", 413, null, "avatar_too_large"))).toMatch(/5 MB/)
    expect(describeAvatarError(new ApiError("x", 429, 3))).toMatch(/Try again in 3 seconds/)
    expect(describeAvatarError(new Error("boom"))).toMatch(/couldn't be saved/)
  })
})

describe("avatarCropPosition (#334)", () => {
  // The API keeps the largest square centered on the point, clamped to the image.
  it("is the center for a centered point or a square image", () => {
    expect(avatarCropPosition(300, 200, null)).toBe("50% 50%")
    expect(avatarCropPosition(200, 200, { x: 0.9, y: 0.1 })).toBe("50% 50%")
  })

  it("matches the clamped crop along the long side", () => {
    // 300x200: the square is 200 wide; at x=0.7 it starts at 110 of the 100 it can move: clamped, 100%.
    expect(avatarCropPosition(300, 200, { x: 0.7, y: 0.5 })).toBe("100% 50%")
    // At x=0.5 it starts at 50 of 100.
    expect(avatarCropPosition(300, 200, { x: 0.5, y: 0.5 })).toBe("50% 50%")
    // At x=0.4 it starts at 20 of 100 (focal % would say 40%).
    expect(avatarCropPosition(300, 200, { x: 0.4, y: 0.5 })).toBe("20% 50%")
    expect(avatarCropPosition(200, 400, { x: 0.5, y: 0 })).toBe("50% 0%")
  })
})

describe("email change (#334)", () => {
  it("validates the new address and the password", () => {
    expect(validateEmailChange({ new_email: "new@example.com", current_password: "pw" }, "old@example.com")).toBeNull()
    expect(validateEmailChange({ new_email: "nope", current_password: "pw" }, "old@example.com")).toMatch(/valid email/)
    expect(validateEmailChange({ new_email: " OLD@example.com ", current_password: "pw" }, "old@example.com")).toMatch(/already your/)
    expect(validateEmailChange({ new_email: "new@example.com", current_password: "" }, "old@example.com")).toMatch(/current password/)
  })

  it("never claims more than that a link was sent", () => {
    expect(emailChangeSentMessage(" new@example.com ", 86400)).toBe(
      "If new@example.com can be used, we've sent it a confirmation link. Your email changes once you open it; the link expires in 24 hours."
    )
    expect(emailChangeSentMessage("a@b.co", 3600)).toContain("1 hour.")
    expect(emailChangeSentMessage("a@b.co")).toContain("24 hours")
  })

  it("explains failures", () => {
    expect(describeEmailChangeError(new ApiError("x", 403, null, "current_password_incorrect"))).toMatch(/incorrect/)
    expect(describeEmailChangeError(new ApiError("x", 400, null, "same_email"))).toMatch(/already your/)
    expect(describeEmailChangeError(new ApiError("x", 429, null))).toMatch(/Too many attempts/)
    expect(describeEmailChangeError(new ApiError("x", 400, null))).toMatch(/valid email/)
  })
})

describe("other devices (#334)", () => {
  it("counts them", () => {
    expect(otherDevicesSummary(0)).toBe("You're not signed in anywhere else.")
    expect(otherDevicesSummary(1)).toBe("You're signed in on 1 other device.")
    expect(otherDevicesSummary(3)).toBe("You're signed in on 3 other devices.")
    expect(signedOutMessage(0)).toBe("No other devices were signed in.")
    expect(signedOutMessage(1)).toBe("Signed out of 1 other device.")
    expect(signedOutMessage(2)).toBe("Signed out of 2 other devices.")
  })

  it("explains failures", () => {
    expect(describeSignOutError(new ApiError("x", 409, null, "session_not_active"))).toMatch(/session has ended/)
    expect(describeSignOutError(new ApiError("x", 401, null))).toMatch(/expired/)
    expect(describeSignOutError(new Error("x"))).toMatch(/couldn't be signed out/)
  })
})