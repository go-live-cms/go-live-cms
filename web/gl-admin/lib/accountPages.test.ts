import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "./api/errors"
import {
  describeAccountError,
  forgetLinkToken,
  mountAcceptInvitePage,
  mountConfirmEmailPage,
  mountForgotPasswordPage,
  mountRegisterPage,
  mountResetPasswordPage,
  mountVerifyEmailPage,
  readLinkToken,
  validateAcceptInvitation,
  validatePassword,
  validateRegistration,
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
    expect(validatePassword("secret-1234", "secret-1234")).toMatch(/at least 12/)
    expect(validatePassword("secret-12345", "secret-23456")).toMatch(/do not match/)
    expect(validatePassword("secret-12345", "secret-12345")).toBeNull()
    // 72 bytes is bcrypt's limit; 30 emoji are 120 bytes.
    expect(validatePassword("😀".repeat(30), "😀".repeat(30))).toMatch(/too long/)
    // The account's details, where the page knows them (#329).
    expect(validatePassword("Ana@Example.com", "Ana@Example.com", ["ana@example.com"])).toMatch(/can't be your email, username or name/)
  })

  it("applies the accept-invite field rules", () => {
    const ok = { username: " newbie ", full_name: "New Person", password: "secret-12345", confirm_password: "secret-12345" }
    expect(validateAcceptInvitation(ok)).toBeNull()
    expect(validateAcceptInvitation({ ...ok, username: "ab" })).toMatch(/Username/)
    expect(validateAcceptInvitation({ ...ok, full_name: " " })).toMatch(/Full name/)
    expect(validateAcceptInvitation({ ...ok, confirm_password: "other" })).toMatch(/match/)
  })

  it("refuses a password that is the username, name or invited email", () => {
    const ok = { username: " longusername ", full_name: " Marisol Duarte ", password: "secret-12345", confirm_password: "secret-12345" }
    const same = (password: string) => ({ ...ok, password, confirm_password: password })
    expect(validateAcceptInvitation(same("LongUsername"))).toMatch(/can't be your email, username or name/)
    expect(validateAcceptInvitation(same("marisol duarte"))).toMatch(/can't be your email, username or name/)
    expect(validateAcceptInvitation(same("Invited@Example.com"), "invited@example.com")).toMatch(/can't be your email, username or name/)
    // Without the preview the email is unknown; the API still checks it.
    expect(validateAcceptInvitation(same("invited@example.com"))).toBeNull()
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
    expect(rule.textContent).toBe("At least 12 characters")
    type(input, "abc")
    expect(rule.textContent).toBe("At least 12 characters (3 so far)")
    expect(rule.classList.contains("is-met")).toBe(false)
    type(input, "abcdefghijkl")
    expect(rule.textContent).toBe("At least 12 characters")
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
    fill({ pw: "long-enough!", confirm_password: "long-enough!" })
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

    fill({ password: "new-secret-1", confirm_password: "new-secret-1" })
    await submit(form)

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/password/reset")
    expect(sentBody()).toEqual({ token: TOKEN, password: "new-secret-1" })
    expect(navigate).toHaveBeenCalledWith("/login?reason=password-reset")
  })

  it("validates before sending", async () => {
    setUrl(`/reset-password#token=${TOKEN}`)
    const form = renderPage("resetForm", ["password", "confirm_password"])
    mountResetPasswordPage(document, vi.fn())
    fill({ password: "new-secret-1", confirm_password: "other-secret-1" })
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

    fill({ password: "new-secret-1", confirm_password: "new-secret-1" })
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
    fill({ password: "new-secret-1", confirm_password: "new-secret-1" })
    await submit(form)
    expect(sentBody()).toEqual({ token: TOKEN, password: "new-secret-1" })
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
  const valid = { username: " newbie ", full_name: " New Person ", password: "secret-12345", confirm_password: "secret-12345" }

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
    expect(sentBody(1)).toEqual({ token: TOKEN, username: "newbie", full_name: "New Person", password: "secret-12345" })
    expect(navigate).toHaveBeenCalledWith("/login?reason=invite-accepted")
  })

  it("refuses the invited email as the password before sending it", async () => {
    setUrl(`/accept-invite#token=${TOKEN}`)
    const form = renderPage("acceptForm", fields)
    fetchMock.mockResolvedValueOnce(json(200, { email: "new.person@example.com", role: "editor", expires_at: "2030-01-01T00:00:00Z" }))
    await mountAcceptInvitePage(document, vi.fn())

    fill({ ...valid, password: "New.Person@example.com", confirm_password: "New.Person@example.com" })
    await submit(form)
    expect(document.getElementById("errorMessage")!.textContent).toMatch(/can't be your email, username or name/)
    expect(fetchMock).toHaveBeenCalledTimes(1) // the preview only
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

describe("confirm email page (#334)", () => {
  const extra = `<section id="emailChanged" hidden><h1 tabindex="-1">Email changed</h1><strong id="newEmail"></strong></section>`

  it("shows the invalid-link panel when the link has no token", () => {
    setUrl("/confirm-email")
    const form = renderPage("confirmEmailForm", [], extra)
    mountConfirmEmailPage(document)
    expect(form.hidden).toBe(true)
    expect(visible("linkInvalid")).toBe(true)
  })

  it("sends nothing until asked, then confirms and shows the new address", async () => {
    setUrl(`/confirm-email#token=${TOKEN}`)
    const form = renderPage("confirmEmailForm", [], extra)
    mountConfirmEmailPage(document)
    expect(window.location.hash).toBe("")
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockResolvedValue(json(200, { message: "email address changed", email: "new@example.com" }))
    await submit(form)

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/email-change/confirm")
    expect(sentBody()).toEqual({ token: TOKEN })
    expect(form.hidden).toBe(true)
    expect(visible("emailChanged")).toBe(true)
    expect(document.getElementById("newEmail")!.textContent).toBe("new@example.com")
    // Used up: a reload has nothing to send.
    expect(sessionStorage.length).toBe(0)
  })

  it("swaps to the invalid-link panel for a used, expired or replaced link", async () => {
    setUrl(`/confirm-email#token=${TOKEN}`)
    const form = renderPage("confirmEmailForm", [], extra)
    mountConfirmEmailPage(document)
    fetchMock.mockResolvedValue(json(400, { error: "this link is invalid or has expired", code: "invalid_token" }))
    await submit(form)
    expect(form.hidden).toBe(true)
    expect(visible("linkInvalid")).toBe(true)
    expect(visible("emailChanged")).toBe(false)
  })

  it("says so when another account took the address meanwhile, and keeps the form", async () => {
    setUrl(`/confirm-email#token=${TOKEN}`)
    const form = renderPage("confirmEmailForm", [], extra)
    mountConfirmEmailPage(document)
    fetchMock.mockResolvedValue(json(409, { error: "another account uses this address now", code: "email_taken" }))
    await submit(form)
    expect(form.hidden).toBe(false)
    expect(errorText()).toMatch(/Another account uses this address/)
    expect(visible("emailChanged")).toBe(false)
  })

  it("explains a network failure and lets you try again", async () => {
    setUrl(`/confirm-email#token=${TOKEN}`)
    const form = renderPage("confirmEmailForm", [], extra)
    mountConfirmEmailPage(document)
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    await submit(form)
    expect(errorText()).toMatch(/Can't reach the server/)
    expect(form.querySelector("button")!.disabled).toBe(false)
  })
})
describe("open signup (#191)", () => {
  const signupFields = ["full_name", "username", "email", "password", "confirm_password"]
  const good = {
    full_name: "Sam Signup",
    username: "samsignup",
    email: "sam@example.com",
    password: "a-long-signup-password",
    confirm_password: "a-long-signup-password",
  }
  const panels = `
    <section id="signupSent" hidden><h1 tabindex="-1">Check your email</h1><strong id="sentTo"></strong>
      <button type="button" id="useAnotherEmail">Use another email</button></section>
    <section id="signupClosed" hidden><h1 tabindex="-1">Sign-up is closed</h1></section>`

  describe("validateRegistration", () => {
    it("accepts a complete form", () => {
      expect(validateRegistration(good)).toBeNull()
    })

    it.each([
      [{ full_name: " a " }, /Your name must be 2–100/],
      [{ username: "sa" }, /Username must be 3–50/],
      [{ username: "sam-signup" }, /letters and numbers/],
      [{ email: "not-an-email" }, /valid email/],
      [{ password: "too-short", confirm_password: "too-short" }, /12/],
      [{ confirm_password: "something-else-entirely" }, /match/i],
      [{ password: "Sam@Example.com", confirm_password: "Sam@Example.com" }, /email|name/i],
      [{ password: "SAMSIGNUP", confirm_password: "SAMSIGNUP" }, /./],
    ])("refuses %o", (change, message) => {
      expect(validateRegistration({ ...good, ...change })).toMatch(message)
    })
  })

  describe("register page", () => {
    it("sends the details and shows one 'check your email' panel", async () => {
      const form = renderPage("registerForm", signupFields, panels)
      mountRegisterPage(document)
      fill({ ...good, email: " sam@example.com " })
      fetchMock.mockResolvedValue(json(202, { message: "Check your email", expires_in_seconds: 86400 }))
      await submit(form)

      expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/register")
      expect(sentBody()).toEqual({ full_name: "Sam Signup", username: "samsignup", email: "sam@example.com", password: good.password })
      expect(form.hidden).toBe(true)
      expect(visible("signupSent")).toBe(true)
      expect(document.getElementById("sentTo")!.textContent).toBe("sam@example.com")
      expect(document.activeElement?.textContent).toBe("Check your email")

      // "Use another email" goes back with everything kept.
      document.getElementById("useAnotherEmail")!.click()
      expect(form.hidden).toBe(false)
      expect(visible("signupSent")).toBe(false)
      expect((document.getElementById("username") as HTMLInputElement).value).toBe("samsignup")
    })

    it("checks the form before sending anything", async () => {
      const form = renderPage("registerForm", signupFields, panels)
      mountRegisterPage(document)
      fill({ ...good, password: "short", confirm_password: "short" })
      await submit(form)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(errorText()).toMatch(/12/)
      expect(visible("errorMessage")).toBe(true)
    })

    it("asks for another username when it isn't available", async () => {
      const form = renderPage("registerForm", signupFields, panels)
      mountRegisterPage(document)
      fill(good)
      fetchMock.mockResolvedValue(json(409, { error: "that username isn't available", code: "username_unavailable" }))
      await submit(form)
      expect(form.hidden).toBe(false)
      expect(errorText()).toMatch(/username isn't available/)
      expect(document.activeElement?.id).toBe("username")
      expect(visible("signupSent")).toBe(false)
    })

    it("shows the closed panel when sign-up was turned off meanwhile", async () => {
      const form = renderPage("registerForm", signupFields, panels)
      mountRegisterPage(document)
      fill(good)
      fetchMock.mockResolvedValue(json(403, { error: "sign-up is closed on this site", code: "signup_disabled" }))
      await submit(form)
      expect(form.hidden).toBe(true)
      expect(visible("signupClosed")).toBe(true)
    })

    it("explains the rate limit", async () => {
      const form = renderPage("registerForm", signupFields, panels)
      mountRegisterPage(document)
      fill(good)
      fetchMock.mockResolvedValue(json(429, { error: "too many requests, try again later" }, { "Retry-After": "30" }))
      await submit(form)
      expect(errorText()).toMatch(/Too many attempts/)
      expect(form.querySelector("button")!.disabled).toBe(false)
    })

    it("does nothing when the page rendered closed", () => {
      const form = renderPage("registerForm", signupFields, panels)
      form.hidden = true
      mountRegisterPage(document)
      form.dispatchEvent(new Event("submit", { cancelable: true }))
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe("verify email page", () => {
    it("shows the invalid-link panel when the link has no token", () => {
      setUrl("/verify-email")
      const form = renderPage("verifyEmailForm", [], panels)
      mountVerifyEmailPage(document, vi.fn())
      expect(form.hidden).toBe(true)
      expect(visible("linkInvalid")).toBe(true)
    })

    it("sends nothing until asked, then creates the account and goes to sign in", async () => {
      setUrl(`/verify-email#token=${TOKEN}`)
      const form = renderPage("verifyEmailForm", [], panels)
      const navigate = vi.fn()
      mountVerifyEmailPage(document, navigate)
      expect(window.location.hash).toBe("")
      expect(fetchMock).not.toHaveBeenCalled()

      fetchMock.mockResolvedValue(json(201, { user: { username: "samsignup" } }))
      await submit(form)
      expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/register/verify")
      expect(sentBody()).toEqual({ token: TOKEN })
      expect(navigate).toHaveBeenCalledWith("/login?reason=signup-confirmed")
      expect(sessionStorage.length).toBe(0)
    })

    it("swaps to the invalid-link panel for a used, expired or replaced link", async () => {
      setUrl(`/verify-email#token=${TOKEN}`)
      const form = renderPage("verifyEmailForm", [], panels)
      const navigate = vi.fn()
      mountVerifyEmailPage(document, navigate)
      fetchMock.mockResolvedValue(json(400, { error: "this link is invalid or has expired", code: "invalid_token" }))
      await submit(form)
      expect(form.hidden).toBe(true)
      expect(visible("linkInvalid")).toBe(true)
      expect(navigate).not.toHaveBeenCalled()
    })

    it("shows the closed panel when sign-up was turned off since", async () => {
      setUrl(`/verify-email#token=${TOKEN}`)
      const form = renderPage("verifyEmailForm", [], panels)
      mountVerifyEmailPage(document, vi.fn())
      fetchMock.mockResolvedValue(json(403, { error: "sign-up is closed on this site", code: "signup_disabled" }))
      await submit(form)
      expect(form.hidden).toBe(true)
      expect(visible("signupClosed")).toBe(true)
      expect(sessionStorage.length).toBe(0)
    })

    it.each([
      ["username_unavailable", /Someone took that username/],
      ["email_registered", /An account with this email already exists/],
    ])("explains %s and keeps the page", async (code, message) => {
      setUrl(`/verify-email#token=${TOKEN}`)
      const form = renderPage("verifyEmailForm", [], panels)
      const navigate = vi.fn()
      mountVerifyEmailPage(document, navigate)
      fetchMock.mockResolvedValue(json(409, { error: "conflict", code }))
      await submit(form)
      expect(form.hidden).toBe(false)
      expect(errorText()).toMatch(message)
      expect(navigate).not.toHaveBeenCalled()
    })
  })

  it("describes the signup codes", () => {
    expect(describeAccountError(new ApiError("x", 409, null, "username_unavailable"))).toMatch(/isn't available/)
    expect(describeAccountError(new ApiError("x", 403, null, "signup_disabled"))).toMatch(/Sign-up is closed/)
  })
})
