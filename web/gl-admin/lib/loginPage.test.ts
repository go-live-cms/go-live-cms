import { beforeEach, describe, expect, it, vi } from "vitest"
import { describeLoginError, mountLoginPage, redirectTarget, signOutNotice, waitHint, type LoginResult } from "./loginPage"

describe("describeLoginError", () => {
  it("says the credentials don't match on a 401", () => {
    expect(describeLoginError({ status: 401, error: "invalid credentials" })).toBe(
      "That username and password don't match. Check both, or reset your password."
    )
  })

  it("honours Retry-After on a 429", () => {
    expect(describeLoginError({ status: 429, retryAfterSeconds: 42 })).toBe("Too many sign-in attempts. Try again in 42 seconds.")
    expect(describeLoginError({ status: 429, retryAfterSeconds: 1 })).toBe("Too many sign-in attempts. Try again in 1 second.")
    expect(describeLoginError({ status: 429, retryAfterSeconds: 600 })).toBe("Too many sign-in attempts. Try again in 10 minutes.")
    expect(describeLoginError({ status: 429 })).toBe("Too many sign-in attempts. Wait a moment and try again.")
  })

  it("never shows the raw error", () => {
    expect(describeLoginError({ error: "Failed to fetch" })).toMatch(/Can't reach the server/)
    expect(describeLoginError({ error: "NetworkError when attempting to fetch resource." })).toMatch(/Can't reach the server/)
    expect(describeLoginError({ status: 502, error: "<html>Bad gateway</html>" })).toMatch(/on the server/)
    expect(describeLoginError({ status: 400, error: "username must be alphanumeric" })).toBe("Sign in failed. Please try again.")
  })
})

describe("waitHint", () => {
  it("rounds long waits up to minutes", () => {
    expect(waitHint(0)).toBe("Wait a moment and try again.")
    expect(waitHint(89)).toBe("Try again in 89 seconds.")
    expect(waitHint(91)).toBe("Try again in 2 minutes.")
  })
})

describe("redirectTarget", () => {
  const origin = "https://cms.example"
  it("follows same-origin paths only", () => {
    expect(redirectTarget("?redirect=/gl-admin/posts?x=1#y", origin)).toBe("/gl-admin/posts?x=1#y")
    expect(redirectTarget("", origin)).toBe("/gl-admin")
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)"]) {
      expect(redirectTarget(`?redirect=${encodeURIComponent(bad)}`, origin)).toBe("/gl-admin")
    }
  })
})

describe("signOutNotice", () => {
  it("shows only known reasons", () => {
    expect(signOutNotice("?reason=password-reset")).toMatch(/password was reset/)
    expect(signOutNotice("?reason=<script>")).toBeNull()
  })
})

describe("mountLoginPage", () => {
  function render() {
    document.body.innerHTML = `
      <form id="loginForm">
        <div id="noticeMessage" hidden><span data-notice-text></span></div>
        <div id="errorMessage" hidden><span data-error-text></span></div>
        <div id="errorAnnouncer"></div>
        <div class="gl-input"><input id="username" name="username" /></div>
        <div class="gl-input"><input id="password" name="password" /></div>
        <button type="submit"><span data-spinner hidden></span><span data-label>Sign in</span></button>
      </form>`
    return document.getElementById("loginForm") as HTMLFormElement
  }

  const auth = (result: LoginResult) => ({
    login: vi.fn().mockResolvedValue(result),
    getDisplayUser: vi.fn().mockReturnValue(null),
    restoreSession: vi.fn(),
  })

  async function submit(form: HTMLFormElement, username: string, password: string) {
    ;(document.getElementById("username") as HTMLInputElement).value = username
    ;(document.getElementById("password") as HTMLInputElement).value = password
    form.dispatchEvent(new Event("submit", { cancelable: true }))
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  }

  const errorText = () => document.querySelector("[data-error-text]")!.textContent

  beforeEach(() => window.history.replaceState(null, "", "/login"))

  it("shows the wrong-credentials error and re-enables the form", async () => {
    const form = render()
    const a = auth({ success: false, status: 401, error: "invalid credentials" })
    mountLoginPage(document, a as never, vi.fn())
    await submit(form, " admin ", "wrong")
    expect(a.login).toHaveBeenCalledWith("admin", "wrong")
    expect(errorText()).toMatch(/don't match/)
    expect(document.getElementById("errorMessage")!.hidden).toBe(false)
    expect(document.getElementById("password")!.getAttribute("aria-invalid")).toBe("true")
    expect(form.querySelector("button")!.disabled).toBe(false)
  })

  it("passes Retry-After through on a 429", async () => {
    const form = render()
    mountLoginPage(document, auth({ success: false, status: 429, retryAfterSeconds: 30 }) as never, vi.fn())
    await submit(form, "admin", "secret")
    expect(errorText()).toBe("Too many sign-in attempts. Try again in 30 seconds.")
  })

  it("asks for both fields before sending", async () => {
    const form = render()
    const a = auth({ success: true })
    mountLoginPage(document, a as never, vi.fn())
    await submit(form, "admin", "")
    expect(a.login).not.toHaveBeenCalled()
    expect(errorText()).toBe("Enter your username and password.")
    expect(document.activeElement?.id).toBe("password")
  })

  it("goes to the redirect target once signed in", async () => {
    window.history.replaceState(null, "", "/login?redirect=/gl-admin/media")
    const form = render()
    const navigate = vi.fn()
    mountLoginPage(document, auth({ success: true }) as never, navigate)
    await submit(form, "admin", "secret")
    expect(navigate).toHaveBeenCalledWith("/gl-admin/media")
    // Still busy while the admin loads, so it can't be sent twice.
    expect(form.querySelector("button")!.disabled).toBe(true)
  })

  it("shows the sign-out notice", () => {
    window.history.replaceState(null, "", "/login?reason=invite-accepted")
    render()
    mountLoginPage(document, auth({ success: true }) as never, vi.fn())
    expect(document.getElementById("noticeMessage")!.hidden).toBe(false)
    expect(document.querySelector("[data-notice-text]")!.textContent).toMatch(/account is ready/)
  })
})
