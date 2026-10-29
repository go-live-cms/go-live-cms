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
    <form id="${formId}">
      <span id="inviterAvatar" hidden></span>
      <p id="inviteSummary"></p>
      <p id="roleDescription" hidden></p>
      <div id="errorMessage" hidden><span data-error-text></span></div>
      <div id="errorAnnouncer"></div>
      <div class="gl-input" id="inviteEmailRow" data-invite-email hidden><input id="inviteEmail" readonly /></div>
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
  sessionStorage.clear()
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
    expect(describeAccountError(new ApiError("x", 429))).toMatch(/Too many attempts. Please wait a minute/)
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

  it("names the address it sent to, and goes back to the form for another", async () => {
    const form = renderPage(
      "forgotForm",
      ["email"],
      `<section id="resetSent" hidden><h1 tabindex="-1">Check</h1><strong id="sentTo"></strong>
       <button type="button" id="tryAnotherEmail">try another email</button></section>`
    )
    mountForgotPasswordPage(document)
    fetchMock.mockResolvedValue(json(200, { message: "ok" }))
    fill({ email: "jane@example.com" })
    await submit(form)

    expect(document.getElementById("sentTo")!.textContent).toBe("jane@example.com")
    expect(document.activeElement?.tagName).toBe("H1")

    document.getElementById("tryAnotherEmail")!.click()
    expect(form.hidden).toBe(false)
    expect(visible("resetSent")).toBe(false)
    expect(document.activeElement?.id).toBe("email")
    expect((document.getElementById("email") as HTMLInputElement).value).toBe("jane@example.com")
    expect(form.querySelector("button")!.disabled).toBe(false)
  })
})

describe("password fields", () => {
  function renderPasswordField() {
    setUrl(`/reset-password#token=${TOKEN}`)
    const form = renderPage(
      "resetForm",
      ["confirm_password"],
      `<div class="gl-input" id="pwField"><input id="pw" name="password" type="password" aria-describedby="pw-rule" />
       <button type="button" data-password-toggle="pw"><span data-toggle-text>Show</span></button>
       <p id="pw-rule" data-password-rule="pw"><span data-rule-text></span></p></div>`
    )
    form.prepend(document.getElementById("pwField")!)
    mountResetPasswordPage(document, vi.fn())
    return document.getElementById("pw") as HTMLInputElement
  }

  function type(input: HTMLInputElement, value: string) {
    input.value = value
    input.dispatchEvent(new Event("input"))
  }

  it("counts towards the API's minimum, then shows it met", () => {
    const input = renderPasswordField()
    const rule = document.getElementById("pw-rule")!
    expect(rule.textContent).toBe("At least 6 characters")
    type(input, "abc")
    expect(rule.textContent).toBe("At least 6 characters (3 so far)")
    expect(rule.classList.contains("is-met")).toBe(false)
    type(input, "abcdef")
    expect(rule.textContent).toBe("At least 6 characters")
    expect(rule.classList.contains("is-met")).toBe(true)
  })

  it("shows and hides the password", () => {
    const input = renderPasswordField()
    const button = document.querySelector<HTMLButtonElement>("[data-password-toggle]")!
    button.click()
    expect(input.type).toBe("text")
    expect(button.textContent).toBe("Hide")
    button.click()
    expect(input.type).toBe("password")
    expect(button.textContent).toBe("Show")
  })

  it("keeps the hint described while an error comes and goes", async () => {
    const input = renderPasswordField()
    const form = document.getElementById("resetForm") as HTMLFormElement
    await submit(form) // too short
    expect(input.getAttribute("aria-describedby")).toBe("errorMessage pw-rule")
    expect(input.getAttribute("aria-invalid")).toBe("true")
    // A second error: hideError ran first, so still exactly one of each.
    await submit(form)
    expect(input.getAttribute("aria-describedby")).toBe("errorMessage pw-rule")
    // Fixed: the error leaves, the hint stays.
    fetchMock.mockResolvedValue(json(200, { message: "ok" }))
    fill({ pw: "long-enough", confirm_password: "long-enough" })
    await submit(form)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(input.getAttribute("aria-describedby")).toBe("pw-rule")
    expect(input.hasAttribute("aria-invalid")).toBe(false)
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
    // The token leaves the address bar at once.
    expect(window.location.hash).toBe("")
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

describe("reloading a link page", () => {
  it("keeps working after the token left the URL, until it is used", async () => {
    setUrl(`/reset-password#token=${TOKEN}`)
    renderPage("resetForm", ["password", "confirm_password"])
    mountResetPasswordPage(document, vi.fn())
    expect(window.location.hash).toBe("")

    // Reload: the fragment is gone, but this tab still has the token.
    const form = renderPage("resetForm", ["password", "confirm_password"])
    const navigate = vi.fn()
    mountResetPasswordPage(document, navigate)
    expect(form.hidden).toBe(false)

    fetchMock.mockResolvedValue(json(200, { message: "ok" }))
    fill({ password: "new-secret", confirm_password: "new-secret" })
    await submit(form)
    expect(sentBody()).toEqual({ token: TOKEN, password: "new-secret" })
    expect(navigate).toHaveBeenCalled()

    // Used up: another reload shows the invalid-link panel.
    renderPage("resetForm", ["password", "confirm_password"])
    mountResetPasswordPage(document, vi.fn())
    expect(visible("linkInvalid")).toBe(true)
  })

  it("forgets a token the API rejected", async () => {
    setUrl(`/accept-invite#token=${TOKEN}`)
    renderPage("acceptForm", ["username", "full_name", "password", "confirm_password"])
    fetchMock.mockResolvedValueOnce(json(400, { error: "x", code: "invalid_token" }))
    await mountAcceptInvitePage(document, vi.fn())
    expect(sessionStorage.length).toBe(0)
  })

  it("keeps tokens per page", () => {
    setUrl(`/accept-invite#token=${TOKEN}`)
    renderPage("acceptForm", ["username"])
    void mountAcceptInvitePage(document, vi.fn())
    setUrl("/reset-password")
    const form = renderPage("resetForm", ["password", "confirm_password"])
    mountResetPasswordPage(document, vi.fn())
    expect(form.hidden).toBe(true)
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
    expect(document.getElementById("inviteSummary")!.textContent).toBe("You've been invited as an Editor.")
    expect((document.getElementById("inviteEmail") as HTMLInputElement).value).toBe("new@example.com")
    expect(visible("inviteEmailRow")).toBe(true)
    expect(document.getElementById("roleDescription")!.textContent).toMatch(/^Editors write, edit and publish/)
    // No inviter (deleted, or an older API): no avatar.
    expect(visible("inviterAvatar")).toBe(false)

    fetchMock.mockResolvedValueOnce(json(201, { user: { id: 1 } }))
    fill(valid)
    await submit(form)

    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/auth/invitations/accept")
    // Trimmed, and no role or email: the invitation decides those.
    expect(sentBody(1)).toEqual({ token: TOKEN, username: "newbie", full_name: "New Person", password: "secret-1" })
    expect(navigate).toHaveBeenCalledWith("/login?reason=invite-accepted")
  })

  it("names the inviter, with their avatar", async () => {
    setUrl(`/accept-invite#token=${TOKEN}`)
    renderPage("acceptForm", fields)
    fetchMock.mockResolvedValueOnce(
      json(200, {
        email: "new@example.com",
        role: "admin",
        expires_at: "2030-01-01T00:00:00Z",
        invited_by: { id: 9, name: "Ana Costa" },
      })
    )
    await mountAcceptInvitePage(document, vi.fn())

    const summary = document.getElementById("inviteSummary")!
    expect(summary.textContent).toBe("Ana Costa invited you as an Administrator.")
    // The role is emphasised as an element, not as markup in a string.
    expect(summary.querySelector("strong")!.textContent).toBe("Administrator")
    const avatar = document.getElementById("inviterAvatar")!
    expect(avatar.hidden).toBe(false)
    expect(avatar.textContent).toBe("A")
    expect(avatar.style.background).toBe("var(--presence-2)")
  })

  it("keeps the form and says why when the preview is rate limited", async () => {
    setUrl(`/accept-invite#token=${TOKEN}`)
    const form = renderPage("acceptForm", fields)
    fetchMock.mockResolvedValueOnce(json(429, { error: "too many requests" }, { "Retry-After": "20" }))
    await mountAcceptInvitePage(document, vi.fn())
    expect(form.hidden).toBe(false)
    expect(visible("linkInvalid")).toBe(false)
    expect(errorText()).toBe("Too many attempts. Try again in 20 seconds.")
    // About the page, not what was typed: no field turns red.
    expect(form.querySelector("[aria-invalid]")).toBeNull()
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
