import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AuthManager } from "./auth"

// #13: the access token lives only in memory and a page load restores the
// session from the httpOnly refresh cookie. Each test builds fresh managers
// (one per simulated tab) instead of using the module singleton.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const expiresAt = () => Math.floor(Date.now() / 1000) + 15 * 60
const USER = { id: 7, username: "editor", full_name: "Ed Itor", email: "editor@example.com", role: "editor" }

let managers: AuthManager[] = []
function newTab(): AuthManager {
  const manager = new (AuthManager as any)() as AuthManager
  managers.push(manager)
  return manager
}

// Every value in Web Storage, to check no token ended up there.
function storedValues(): string[] {
  const values: string[] = []
  for (const storage of [localStorage, sessionStorage]) {
    for (let i = 0; i < storage.length; i++) values.push(storage.getItem(storage.key(i)!) ?? "")
  }
  return values
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  for (const manager of managers) (manager as any).channel?.close()
  managers = []
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (navigator as any).locks
})

describe("AuthManager session restore", () => {
  it("removes the legacy token keys from localStorage on load", () => {
    localStorage.setItem("access_token", "old-token")
    localStorage.setItem("token_expiry", String(Date.now() + 60_000))
    localStorage.setItem("user", JSON.stringify(USER))
    localStorage.setItem("sidebarState", "true")

    const tab = newTab()

    expect(localStorage.getItem("access_token")).toBeNull()
    expect(localStorage.getItem("token_expiry")).toBeNull()
    expect(localStorage.getItem("user")).toBeNull()
    expect(localStorage.getItem("sidebarState")).toBe("true")
    // The stored token is not picked up either.
    expect(tab.getState().isAuthenticated).toBe(false)
    expect(tab.getAccessToken()).toBeNull()
  })

  it("restores the session on load with a silent refresh, then loads the user", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/v1/auth/refresh") {
        expect(init.credentials).toBe("include")
        return json(200, { access_token: "fresh-token", expires_at: expiresAt() })
      }
      if (url === "/api/v1/users/me") {
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fresh-token")
        return json(200, { user: USER })
      }
      return json(500, { error: `unexpected ${url}` })
    })
    vi.stubGlobal("fetch", fetchMock)

    const tab = newTab()
    expect(tab.getState().isAuthenticated).toBe(false)

    await expect(tab.restoreSession()).resolves.toBe(true)

    expect(tab.getAccessToken()).toBe("fresh-token")
    expect(tab.getState().user).toEqual(USER)
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/v1/auth/refresh", "/api/v1/users/me"])

    // Only display data is stored, and no token anywhere.
    expect(JSON.parse(localStorage.getItem("gl-auth-user")!)).toEqual({ id: 7, username: "editor", full_name: "Ed Itor" })
    expect(storedValues().some((v) => v.includes("fresh-token"))).toBe(false)

    // A valid in-memory token needs no second refresh.
    await expect(tab.restoreSession()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("stays signed out when the refresh fails, without reporting an expired session", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { error: "session is blocked" })))
    localStorage.setItem("gl-auth-user", JSON.stringify({ id: 7, username: "editor" }))

    const tab = newTab()
    const listener = vi.fn()
    tab.subscribe(listener)

    await expect(tab.restoreSession()).resolves.toBe(false)

    expect(tab.getState().isAuthenticated).toBe(false)
    expect(tab.getAccessToken()).toBeNull()
    // The display hint goes with the session, so the login page won't retry.
    expect(tab.getDisplayUser()).toBeNull()
    // Nothing changed, so AuthGuard's subscriber doesn't redirect with "session-expired".
    expect(listener).not.toHaveBeenCalled()
  })

  it("shares one refresh between concurrent callers", async () => {
    let release!: () => void
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/v1/auth/refresh") {
        return new Promise<Response>((resolve) => {
          release = () => resolve(json(200, { access_token: "fresh-token", expires_at: expiresAt() }))
        })
      }
      return Promise.resolve(json(200, { user: USER }))
    })
    vi.stubGlobal("fetch", fetchMock)

    const tab = newTab()
    const calls = [tab.restoreSession(), tab.restoreSession(), tab.forceRefresh(), tab.refreshAccessToken()]
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    release()

    await expect(Promise.all(calls)).resolves.toEqual([true, true, true, true])
    expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/v1/auth/refresh")).toHaveLength(1)
    expect(tab.getAccessToken()).toBe("fresh-token")
  })

  it("signs out with 'session-expired' when a refresh fails mid-session", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { error: "session is blocked" })))
    const tab = newTab()
    tab.adoptAccessToken({ access_token: "tok", expires_at: expiresAt() })
    const seen: boolean[] = []
    tab.subscribe((s) => seen.push(s.isAuthenticated))

    await expect(tab.forceRefresh()).resolves.toBe(false)

    expect(seen).toEqual([false])
    expect(tab.getSignOutReason()).toBe("session-expired")
    expect(tab.getAccessToken()).toBeNull()
  })

  it("never writes the token to storage on login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, { access_token: "login-token", expires_at: expiresAt(), user: USER }))
    )
    const tab = newTab()

    await expect(tab.login("editor", "pw")).resolves.toEqual({ success: true })

    expect(tab.getAccessToken()).toBe("login-token")
    expect(tab.getDisplayUser()).toEqual({ id: 7, username: "editor", full_name: "Ed Itor" })
    expect(storedValues().some((v) => v.includes("login-token"))).toBe(false)
    // The display hint holds no email or role.
    expect(localStorage.getItem("gl-auth-user")).not.toContain("example.com")
  })

  it("logout revokes the server session and clears memory and storage", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url === "/api/v1/auth/logout"
        ? json(200, { message: "logged out successfully" })
        : json(200, { access_token: "login-token", expires_at: expiresAt(), user: USER })
    )
    vi.stubGlobal("fetch", fetchMock)
    const tab = newTab()
    await tab.login("editor", "pw")

    await tab.logout()

    const logoutCall = fetchMock.mock.calls.find((c) => c[0] === "/api/v1/auth/logout")!
    expect((logoutCall[1] as RequestInit).credentials).toBe("include")
    expect(tab.getState()).toMatchObject({ isAuthenticated: false, accessToken: null, user: null })
    expect(tab.getDisplayUser()).toBeNull()
    expect(tab.getSignOutReason()).toBe("signed-out")
  })
})

describe("AuthManager across tabs", () => {
  // A minimal navigator.locks: one exclusive lock, granted in request order.
  function installLocks() {
    let tail: Promise<unknown> = Promise.resolve()
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_name: string, fn: () => Promise<unknown>) => {
          const run = tail.then(fn)
          tail = run.catch(() => {})
          return run
        },
      },
    })
  }

  it("serializes refreshes so tabs never present the same refresh cookie at once", async () => {
    installLocks()
    let inFlight = 0
    let maxInFlight = 0
    let issued = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/v1/auth/refresh") {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((r) => setTimeout(r, 20))
          inFlight--
          return json(200, { access_token: `token-${++issued}`, expires_at: expiresAt() })
        }
        return json(200, { user: USER })
      })
    )

    // Two tabs loading at the same time.
    const a = newTab()
    const b = newTab()
    await expect(Promise.all([a.restoreSession(), b.restoreSession()])).resolves.toEqual([true, true])

    expect(maxInFlight).toBe(1)
    expect(a.getState().isAuthenticated).toBe(true)
    expect(b.getState().isAuthenticated).toBe(true)
  })

  it("shares a new token with the other tabs, which then skip their own refresh", async () => {
    const a = newTab()
    const b = newTab()

    a.adoptAccessToken({ access_token: "shared-token", expires_at: expiresAt() })

    await vi.waitFor(() => expect(b.getAccessToken()).toBe("shared-token"))
    expect(b.getState().isAuthenticated).toBe(true)

    // b now holds a valid token: restoring needs no refresh.
    const fetchMock = vi.fn(async (_url: string) => json(200, { user: USER }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(b.restoreSession()).resolves.toBe(true)
    expect(fetchMock.mock.calls.some((c) => c[0] === "/api/v1/auth/refresh")).toBe(false)
  })

  it("ignores a broadcast token older than the one it holds", async () => {
    const a = newTab()
    const b = newTab()
    b.adoptAccessToken({ access_token: "newer", expires_at: expiresAt() + 600 })
    a.adoptAccessToken({ access_token: "older", expires_at: expiresAt() })
    // Let b's broadcast reach a, and a's reach b.
    await vi.waitFor(() => expect(a.getAccessToken()).toBe("newer"))
    await new Promise((r) => setTimeout(r, 20))
    expect(b.getAccessToken()).toBe("newer")
  })

  it("logging out in one tab signs the others out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { message: "logged out successfully" })))
    const a = newTab()
    const b = newTab()
    a.adoptAccessToken({ access_token: "tok", expires_at: expiresAt() })
    await vi.waitFor(() => expect(b.getAccessToken()).toBe("tok"))

    const seen: boolean[] = []
    b.subscribe((s) => seen.push(s.isAuthenticated))
    await a.logout()

    await vi.waitFor(() => expect(b.getState().isAuthenticated).toBe(false))
    expect(seen).toEqual([false])
    expect(b.getSignOutReason()).toBe("signed-out")
  })
})
