// The sign-in page (/login, web/src/pages/login). Like the other account pages
// (accountPages.ts) it lives outside the admin SPA and its <script> only calls
// mountLoginPage, so the logic is bundled (no inline script, CSP #161) and
// tested here. The auth manager is passed in: importing lib/auth.ts here would
// start one in every test.
import type { AuthManager } from "./auth"
import { formUi } from "./accountPages"
import { retryAfterHint } from "./profile"

export type LoginResult = {
  success: boolean
  error?: string
  status?: number
  retryAfterSeconds?: number | null
}

type LoginAuth = Pick<AuthManager, "login" | "getDisplayUser" | "restoreSession">

// ?redirect= comes from AuthGuard (the page the user was on), but anyone can
// craft a login link with it. Only follow same-origin paths, so the page can't
// be used to bounce a freshly signed-in user to another site or a javascript: URL.
export function redirectTarget(search: string, origin: string): string {
  const fallback = "/gl-admin"
  const raw = new URLSearchParams(search).get("redirect")
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback
  try {
    const url = new URL(raw, origin)
    if (url.origin !== origin) return fallback
    return url.pathname + url.search + url.hash
  } catch {
    return fallback
  }
}

// Set by the admin's AuthGuard when it signs the user out (lib/auth.ts
// SignOutReason), or by the account pages (lib/accountPages.ts). Only known
// reasons are shown; the text is ours.
const SIGN_OUT_NOTICES: Record<string, string> = {
  "password-changed": "Your password was changed. Sign in with your new password.",
  "session-expired": "Your session has expired. Please sign in again.",
  "password-reset": "Your password was reset and every session signed out. Sign in with your new password.",
  "invite-accepted": "Your account is ready. Sign in with your new username and password.",
}

export function signOutNotice(search: string): string | null {
  return SIGN_OUT_NOTICES[new URLSearchParams(search).get("reason") ?? ""] ?? null
}

// authManager.login returns the HTTP status when the API answered, and the
// raw message otherwise (the browser's fetch error when the API can't be
// reached). Never show those messages.
export function describeLoginError(result: Omit<LoginResult, "success">): string {
  const { status, error, retryAfterSeconds } = result
  if (status === 401) return "That username and password don't match. Check both, or reset your password."
  if (status === 429) return `Too many sign-in attempts. ${retryAfterHint(retryAfterSeconds)}`
  // LoginUserRequest's binding: a username that isn't alphanumeric (someone
  // typing their email, say), or a password shorter than any real one.
  if (status === 400) {
    return "That username and password don't match. Usernames are letters and numbers only; check both, or reset your password."
  }
  if (error && /failed to fetch|networkerror|load failed|network request failed/i.test(error)) {
    return "Can't reach the server. Check your connection and try again."
  }
  if (status != null && status >= 500) return "Something went wrong on the server. Please try again in a moment."
  return "Sign in failed. Please try again."
}

type Navigate = (url: string) => void

export function mountLoginPage(
  doc: Document,
  auth: LoginAuth,
  navigate: Navigate = (url) => {
    doc.defaultView!.location.href = url
  }
): void {
  const win = doc.defaultView!
  const form = doc.getElementById("loginForm") as HTMLFormElement
  const ui = formUi(doc, form, "Sign in", "Signing in…")
  const inputs = Array.from(form.querySelectorAll<HTMLInputElement>("input"))
  const target = () => redirectTarget(win.location.search, win.location.origin)

  // The access token isn't stored, so "already signed in?" means a refresh
  // cookie that still works. Only try when the last session left its display
  // user behind; a failed restore clears it, so this can't loop with AuthGuard.
  if (auth.getDisplayUser()) {
    void auth.restoreSession().then((restored) => {
      if (restored) navigate(target())
    })
  }

  const notice = signOutNotice(win.location.search)
  const noticeBox = doc.getElementById("noticeMessage")
  if (notice && noticeBox) {
    const text = noticeBox.querySelector<HTMLElement>("[data-notice-text]") ?? noticeBox
    text.textContent = notice
    noticeBox.hidden = false
  }

  // Coming Back from the admin restores this page from the bfcache with the
  // loading state still set; reset it so the form is usable again.
  win.addEventListener("pageshow", (e) => {
    if (e.persisted) ui.setLoading(false)
  })

  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    ui.hideError()

    const formData = new FormData(form)
    const username = ((formData.get("username") as string | null) ?? "").trim()
    const password = (formData.get("password") as string | null) ?? ""

    if (!username || !password) {
      ui.showError("Enter your username and password.")
      ;(username ? inputs[1] : inputs[0])?.focus()
      return
    }

    ui.setLoading(true)

    let result: LoginResult
    try {
      result = await auth.login(username, password)
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : undefined }
    }

    if (result.success) {
      // Stay in the loading state while the admin loads, so the button
      // can't be clicked again and send a second login.
      navigate(target())
      return
    }

    ui.setLoading(false)
    ui.showError(describeLoginError(result))
  })
}
