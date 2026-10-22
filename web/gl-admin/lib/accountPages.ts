// The signed-out account pages (#148): /forgot-password, /reset-password and
// /accept-invite (web/src/pages). Like /login they live outside the admin SPA
// and are plain forms; each page's <script> only calls its mount function, so
// the logic is bundled (no inline script, CSP #161) and tested here.
//
// Emailed links carry their token in the URL fragment (#token=...), which the
// browser never sends to a server. The page reads it, moves it from the
// address bar and history into this tab's session storage (so a reload still
// works), and POSTs it to the API.
import { ApiError, apiErrorFromResponse } from "./api/errors"
import { FULL_NAME_MAX, FULL_NAME_MIN, USERNAME_MAX, USERNAME_MIN, retryHint, validateNewPassword } from "./profile"
import { USER_ROLE_OPTIONS } from "./roles"

const API_BASE = "/api/v1"

// The API's own limit (bcrypt), in UTF-8 bytes.
export const PASSWORD_MAX_BYTES = 72

// --- API --------------------------------------------------------------------

async function postJSON<T>(endpoint: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await apiErrorFromResponse(response, { authEndpoint: true })
  try {
    return (await response.json()) as T
  } catch {
    return {} as T
  }
}

export function requestPasswordReset(email: string): Promise<{ message: string }> {
  return postJSON("/auth/password/forgot", { email })
}

export function resetPassword(token: string, password: string): Promise<{ message: string }> {
  return postJSON("/auth/password/reset", { token, password })
}

export interface InvitationPreview {
  email: string
  role: string
  expires_at: string
}

export function previewInvitation(token: string): Promise<InvitationPreview> {
  return postJSON("/auth/invitations/preview", { token })
}

export interface AcceptInvitationFields {
  username: string
  full_name: string
  password: string
  confirm_password: string
}

export function acceptInvitation(token: string, fields: AcceptInvitationFields): Promise<unknown> {
  return postJSON("/auth/invitations/accept", {
    token,
    username: fields.username.trim(),
    full_name: fields.full_name.trim(),
    password: fields.password,
  })
}

// --- Tokens -----------------------------------------------------------------

// The token from a link's fragment ("#token=..."), or null.
export function readLinkToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token")
  return token && /^[A-Za-z0-9_-]+$/.test(token) ? token : null
}

// Removes the fragment from the address bar and the history entry, so the
// token isn't left behind for someone else at the same computer.
export function forgetLinkToken(win: Window): void {
  if (!win.location.hash) return
  win.history.replaceState(win.history.state, "", win.location.pathname + win.location.search)
}

// Once the token is out of the URL, a reload would lose it and show a working
// link as invalid. So it is kept in sessionStorage (this tab only, gone when
// the tab closes) until the page is done with it.
const tokenStorageKey = (win: Window) => `gl-account-link-token:${win.location.pathname}`

// The page's token: from the link's fragment (then moved out of the URL into
// session storage), or from session storage after a reload. Null if neither.
export function takeLinkToken(win: Window): string | null {
  const key = tokenStorageKey(win)
  const fromLink = readLinkToken(win.location.hash)
  forgetLinkToken(win)
  try {
    if (fromLink) {
      win.sessionStorage.setItem(key, fromLink)
      return fromLink
    }
    return readLinkToken(`token=${win.sessionStorage.getItem(key) ?? ""}`)
  } catch {
    return fromLink // storage blocked: the token works until a reload
  }
}

// Drops the stored token once it has been used up or found invalid.
export function dropLinkToken(win: Window): void {
  try {
    win.sessionStorage.removeItem(tokenStorageKey(win))
  } catch {
    // Storage blocked: nothing was stored.
  }
}

// --- Validation and messages ------------------------------------------------

const runeLength = (s: string) => [...s].length
const byteLength = (s: string) => new TextEncoder().encode(s).length

export function validatePassword(password: string, confirm: string): string | null {
  const invalid = validateNewPassword(password, confirm, "Password")
  if (invalid) return invalid
  if (byteLength(password) > PASSWORD_MAX_BYTES) return "Password is too long."
  return null
}

// Mirrors AcceptInvitationRequest's binding tags (api/account_bindings.go).
export function validateAcceptInvitation(fields: AcceptInvitationFields): string | null {
  const username = fields.username.trim()
  const fullName = fields.full_name.trim()
  if (runeLength(username) < USERNAME_MIN || runeLength(username) > USERNAME_MAX) {
    return `Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters.`
  }
  if (runeLength(fullName) < FULL_NAME_MIN || runeLength(fullName) > FULL_NAME_MAX) {
    return `Full name must be ${FULL_NAME_MIN}–${FULL_NAME_MAX} characters.`
  }
  return validatePassword(fields.password, fields.confirm_password)
}

export function isInvalidLinkError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "invalid_token"
}

// User-facing text for a failed request on these pages.
export function describeAccountError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return `Too many attempts. ${retryHint(err)}`
    if (err.code === "invalid_token") return "This link is invalid or has expired."
    if (err.code === "username_taken") return "That username is taken. Choose another one."
    if (err.code === "email_registered") return "An account with this email already exists. Sign in, or reset its password."
    if (err.status >= 500) return "Something went wrong on the server. Please try again in a moment."
    return err.message
  }
  if (err instanceof Error && /failed to fetch|networkerror|load failed|network request failed/i.test(err.message)) {
    return "Can't reach the server. Check your connection and try again."
  }
  return "Something went wrong. Please try again."
}

export function roleLabel(role: string): string {
  return USER_ROLE_OPTIONS.find((o) => o.value === role)?.label ?? role
}

// --- Page wiring ------------------------------------------------------------

// The shared form chrome of the account pages (same markup as /login): an
// error box mirrored to a live region, and a submit button with a spinner.
function formUi(doc: Document, form: HTMLFormElement, idleLabel: string, busyLabel: string) {
  const error = doc.getElementById("errorMessage") as HTMLElement
  const announcer = doc.getElementById("errorAnnouncer") as HTMLElement
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!
  const label = button.querySelector<HTMLElement>("[data-label]")
  const spinner = button.querySelector<HTMLElement>("[data-spinner]")
  const inputs = Array.from(form.querySelectorAll<HTMLInputElement>("input"))
  const win = doc.defaultView!
  let announceTimer: number | undefined

  const setInvalid = (invalid: boolean) => {
    for (const input of inputs) {
      input.closest(".gl-input")?.classList.toggle("is-invalid", invalid)
      if (invalid) {
        input.setAttribute("aria-invalid", "true")
        input.setAttribute("aria-describedby", "errorMessage")
      } else {
        input.removeAttribute("aria-invalid")
        input.removeAttribute("aria-describedby")
      }
    }
  }

  return {
    showError(message: string) {
      error.textContent = message
      error.hidden = false
      setInvalid(true)
      // A live region only speaks when its text changes: clear, then set.
      win.clearTimeout(announceTimer)
      announcer.textContent = ""
      announceTimer = win.setTimeout(() => {
        announcer.textContent = message
      }, 100)
    },
    hideError() {
      error.hidden = true
      error.textContent = ""
      setInvalid(false)
    },
    setLoading(loading: boolean) {
      button.disabled = loading
      button.setAttribute("aria-busy", String(loading))
      if (spinner) spinner.hidden = !loading
      if (label) label.textContent = loading ? busyLabel : idleLabel
    },
  }
}

function field(form: HTMLFormElement, name: string): string {
  return (new FormData(form).get(name) as string | null) ?? ""
}

// Swaps the form for the "this link doesn't work" panel, and forgets the
// stored token.
function showInvalidLink(doc: Document, form: HTMLFormElement) {
  dropLinkToken(doc.defaultView!)
  form.hidden = true
  const panel = doc.getElementById("linkInvalid")
  if (panel) panel.hidden = false
}

// Where the pages go after success (injectable for tests: jsdom can't navigate).
type Navigate = (url: string) => void
const defaultNavigate = (doc: Document): Navigate => (url) => doc.defaultView!.location.assign(url)

export function mountForgotPasswordPage(doc: Document = document): void {
  const form = doc.getElementById("forgotForm") as HTMLFormElement
  const ui = formUi(doc, form, "Send reset link", "Sending…")

  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    ui.hideError()
    const email = field(form, "email").trim()
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      ui.showError("Enter the email address of your account.")
      return
    }
    ui.setLoading(true)
    try {
      await requestPasswordReset(email)
    } catch (err) {
      ui.setLoading(false)
      ui.showError(describeAccountError(err))
      return
    }
    // Same text whether or not the email has an account (the API doesn't say).
    form.hidden = true
    const sent = doc.getElementById("resetSent")
    if (sent) sent.hidden = false
  })
}

export function mountResetPasswordPage(doc: Document = document, navigate: Navigate = defaultNavigate(doc)): void {
  const win = doc.defaultView!
  const form = doc.getElementById("resetForm") as HTMLFormElement
  const ui = formUi(doc, form, "Set new password", "Saving…")
  const token = takeLinkToken(win)
  if (!token) {
    showInvalidLink(doc, form)
    return
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    ui.hideError()
    const password = field(form, "password")
    const invalid = validatePassword(password, field(form, "confirm_password"))
    if (invalid) {
      ui.showError(invalid)
      return
    }
    ui.setLoading(true)
    try {
      await resetPassword(token, password)
    } catch (err) {
      ui.setLoading(false)
      if (isInvalidLinkError(err)) {
        showInvalidLink(doc, form)
        return
      }
      ui.showError(describeAccountError(err))
      return
    }
    dropLinkToken(win)
    navigate("/login?reason=password-reset")
  })
}

export async function mountAcceptInvitePage(
  doc: Document = document,
  navigate: Navigate = defaultNavigate(doc),
): Promise<void> {
  const win = doc.defaultView!
  const form = doc.getElementById("acceptForm") as HTMLFormElement
  const ui = formUi(doc, form, "Create account", "Creating account…")
  const token = takeLinkToken(win)
  if (!token) {
    showInvalidLink(doc, form)
    return
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    ui.hideError()
    const fields: AcceptInvitationFields = {
      username: field(form, "username"),
      full_name: field(form, "full_name"),
      password: field(form, "password"),
      confirm_password: field(form, "confirm_password"),
    }
    const invalid = validateAcceptInvitation(fields)
    if (invalid) {
      ui.showError(invalid)
      return
    }
    ui.setLoading(true)
    try {
      await acceptInvitation(token, fields)
    } catch (err) {
      ui.setLoading(false)
      if (isInvalidLinkError(err)) {
        showInvalidLink(doc, form)
        return
      }
      ui.showError(describeAccountError(err))
      return
    }
    dropLinkToken(win)
    navigate("/login?reason=invite-accepted")
  })

  // Show who the invitation is for; a dead link gets the invalid panel now
  // rather than after the form is filled in.
  try {
    const invite = await previewInvitation(token)
    const summary = doc.getElementById("inviteSummary")
    if (summary) {
      summary.textContent = `You've been invited as ${roleLabel(invite.role)} (${invite.email}). Choose a username and password to finish.`
    }
  } catch (err) {
    if (isInvalidLinkError(err)) showInvalidLink(doc, form)
    // Other failures (network, 429): leave the form; submitting will report it.
  }
}
