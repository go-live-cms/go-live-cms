import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "./api/errors"
import {
  describeAccountError,
  forgetLinkToken,
  mountAcceptInvitePage,
  mountForgotPasswordPage,
  mountResetPasswordPage,
  readLinkToken,
  validateAcceptInvitation,
  validatePassword,
} from "./accountPages"

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

// The markup the Astro pages render (web/src/layouts/AccountPage.astro + page).
function renderPage(formId: string, fields: string[], extra = "") {
  document.body.innerHTML = `
    <p id="errorMessage" hidden></p>
    <div id="errorAnnouncer"></div>
    <form id="${formId}">
      <p id="inviteSummary"></p>
      ${fields.map((name) => `<div class="gl-input"><input name="${name}" id="${name}" /></div>`).join("")}
      <button type="submit"><span data-spinner hidden></span><span data-label>Go</span></button>
    </form>
    <div id="linkInvalid" hidden></div>
    ${extra}`
  return document.getElementById(formId) as HTMLFormElement
}

function fill(values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    ;(document.getElementById(name) as HTMLInputElement).value = value
  }
}

async function submit(form: HTMLFormElement) {
  form.dispatchEvent(new Event("submit", { cancelable: true }))
  // Let the handler's awaits (fetch, response.json) settle. On success the
  // button stays disabled while the page navigates, so wait on time, not it.
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

const errorText = () => document.getElementById("errorMessage")!.textContent
const visible = (id: string) => !document.getElementById(id)!.hidden

function setUrl(url: string) {
  window.history.replaceState(null, "", url)
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
  setUrl("/")
})

function sentBody(call = 0) {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string)
}

describe("link tokens", () => {
  it("reads the token from the fragment only", () => {
    expect(readLinkToken(`#token=${TOKEN}`)).toBe(TOKEN)
    expect(readLinkToken(`token=${TOKEN}`)).toBe(TOKEN)
    expect(readLinkToken("")).toBeNull()
    expect(readLinkToken("#token=")).toBeNull()
    expect(readLinkToken("#token=<script>")).toBeNull()
  })

  it("removes the token from the address bar and history entry", () => {
    setUrl(`/reset-password?x=1#token=${TOKEN}`)
    forgetLinkToken(window)
    expect(window.location.hash).toBe("")
    expect(window.location.pathname + window.location.search).toBe("/reset-password?x=1")
  })
})

describe("validation", () => {
  it("applies the API's password rules", () => {
    expect(validatePassword("12345", "12345")).toMatch(/at least 6/)
    expect(validatePassword("secret-1", "secret-2")).toMatch(/do not match/)
    expect(validatePassword("secret-1", "secret-1")).toBeNull()
    // 72 bytes is bcrypt's limit; 30 emoji are 120 bytes.
    expect(validatePassword("😀".repeat(30), "😀".repeat(30))).toMatch(/too long/)
  })

  it("applies the accept-invite field rules", () => {
    const ok = { username: " newbie ", full_name: "New Person", password: "secret-1", confirm_password: "secret-1" }
    expect(validateAcceptInvitation(ok)).toBeNull()
    expect(validateAcceptInvitation({ ...ok, username: "ab" })).toMatch(/Username/)
    expect(validateAcceptInvitation({ ...ok, full_name: " " })).toMatch(/Full name/)
    expect(validateAcceptInvitation({ ...ok, confirm_password: "other" })).toMatch(/match/)
  })

  it("turns API codes into readable messages", () => {
    expect(describeAccountError(new ApiError("x", 400, null, "invalid_token"))).toMatch(/invalid or has expired/)
    expect(describeAccountError(new ApiError("x", 409, null, "username_taken"))).toMatch(/username is taken/)
    expect(describeAccountError(new ApiError("x", 409, null, "email_registered"))).toMatch(/already exists/)
    expect(describeAccountError(new ApiError("x", 429, 12))).toMatch(/12 seconds/)
    expect(describeAccountError(new ApiError("x", 500))).toMatch(/server/)
    expect(describeAccountError(new TypeError("Failed to fetch"))).toMatch(/Can't reach the server/)
  })
})

describe("forgot password page", () => {
  it("sends the email and shows the same confirmation whatever the answer", async () => {
    const form = renderPage("forgotForm", ["email"], `<div id="resetSent" hidden></div>`)
    mountForgotPasswordPage(document)
    fetchMock.mockResolvedValue(json(200, { message: "ok" }))

    fill({ email: "  jane@example.com " })
    await submit(form)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/password/forgot")
    expect(sentBody()).toEqual({ email: "jane@example.com" })
    expect(form.hidden).toBe(true)
    expect(visible("resetSent")).toBe(true)
  })

  it("checks the email before sending", async () => {
    const form = renderPage("forgotForm", ["email"], `<div id="resetSent" hidden></div>`)
    mountForgotPasswordPage(document)
    fill({ email: "jane" })
    await submit(form)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errorText()).toMatch(/email/)
  })

  it("reports rate limiting", async () => {
    const form = renderPage("forgotForm", ["email"], `<div id="resetSent" hidden></div>`)
    mountForgotPasswordPage(document)
    fetchMock.mockResolvedValue(json(429, { error: "too many requests" }, { "Retry-After": "30" }))
    fill({ email: "jane@example.com" })
    await submit(form)
    expect(errorText()).toMatch(/30 seconds/)
    expect(visible("resetSent")).toBe(false)
  })
})

describe("reset password page", () => {
  it("shows the invalid-link panel when the link has no token", () => {
    setUrl("/reset-password")
    const form = renderPage("resetForm", ["password", "confirm_password"])
    mountResetPasswordPage(document, vi.fn())
    expect(form.hidden).toBe(true)
    expect(visible("linkInvalid")).toBe(true)
  })

  it("posts the token from the fragment and goes to sign in", async () => {
    setUrl(`/reset-password#token=${TOKEN}`)
    const form = renderPage("resetForm", ["password", "confirm_password"])
    const navigate = vi.fn()
    mountResetPasswordPage(document, navigate)
    expect(window.location.hash).toBe("", "the token leaves the address bar at once")
    fetchMock.mockResolvedValue(json(200, { message: "ok" }))

    fill({ password: "new-secret", confirm_password: "new-secret" })
    await submit(form)

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/password/reset")
    expect(sentBody()).toEqual({ token: TOKEN, password: "new-secret" })
    expect(navigate).toHaveBeenCalledWith("/login?reason=password-reset")
  })

  it("validates before sending", async () => {
    setUrl(`/reset-password#token=${TOKEN}`)
    const form = renderPage("resetForm", ["password", "confirm_password"])
    mountResetPasswordPage(document, vi.fn())
    fill({ password: "new-secret", confirm_password: "other-secret" })
    await submit(form)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errorText()).toMatch(/do not match/)
  })

  it("swaps to the invalid-link panel for a used or expired link", async () => {
    setUrl(`/reset-password#token=${TOKEN}`)
    const form = renderPage("resetForm", ["password", "confirm_password"])
    const navigate = vi.fn()
    mountResetPasswordPage(document, navigate)
    fetchMock.mockResolvedValue(json(400, { error: "this link is invalid or has expired", code: "invalid_token" }))

    fill({ password: "new-secret", confirm_password: "new-secret" })
    await submit(form)

    expect(form.hidden).toBe(true)
    expect(visible("linkInvalid")).toBe(true)
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe("accept invitation page", () => {
  const fields = ["username", "full_name", "password", "confirm_password"]
  const valid = { username: " newbie ", full_name: " New Person ", password: "secret-1", confirm_password: "secret-1" }

  it("shows who the invitation is for, then creates the account", async () => {
    setUrl(`/accept-invite#token=${TOKEN}`)
    const form = renderPage("acceptForm", fields)
    const navigate = vi.fn()
    fetchMock.mockResolvedValueOnce(json(200, { email: "new@example.com", role: "editor", expires_at: "2030-01-01T00:00:00Z" }))
    await mountAcceptInvitePage(document, navigate)

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/invitations/preview")
    expect(sentBody(0)).toEqual({ token: TOKEN })
    expect(document.getElementById("inviteSummary")!.textContent).toContain("Editor (new@example.com)")

    fetchMock.mockResolvedValueOnce(json(201, { user: { id: 1 } }))
    fill(valid)
    await submit(form)

    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/auth/invitations/accept")
    // Trimmed, and no role or email: the invitation decides those.
    expect(sentBody(1)).toEqual({ token: TOKEN, username: "newbie", full_name: "New Person", password: "secret-1" })
    expect(navigate).toHaveBeenCalledWith("/login?reason=invite-accepted")
  })

  it("shows the invalid-link panel up front for a dead link", async () => {
    setUrl(`/accept-invite#token=${TOKEN}`)
    const form = renderPage("acceptForm", fields)
    fetchMock.mockResolvedValueOnce(json(400, { error: "x", code: "invalid_token" }))
    await mountAcceptInvitePage(document, vi.fn())
    expect(form.hidden).toBe(true)
    expect(visible("linkInvalid")).toBe(true)
  })

  it("keeps the form on a taken username", async () => {
    setUrl(`/accept-invite#token=${TOKEN}`)
    const form = renderPage("acceptForm", fields)
    const navigate = vi.fn()
    fetchMock.mockResolvedValueOnce(json(200, { email: "new@example.com", role: "contributor", expires_at: "2030-01-01T00:00:00Z" }))
    await mountAcceptInvitePage(document, navigate)

    fetchMock.mockResolvedValueOnce(json(409, { error: "that username is taken", code: "username_taken" }))
    fill(valid)
    await submit(form)

    expect(errorText()).toMatch(/username is taken/)
    expect(form.hidden).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
    expect(form.querySelector("button")!.disabled).toBe(false)
  })

  it("does nothing but show the panel without a token", async () => {
    setUrl("/accept-invite")
    renderPage("acceptForm", fields)
    await mountAcceptInvitePage(document, vi.fn())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(visible("linkInvalid")).toBe(true)
  })
})
