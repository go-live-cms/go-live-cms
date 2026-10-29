// Renders the signed-out account pages (#344) with Astro's Container API and
// checks the markup their scripts (gl-admin/lib/accountPages.ts, loginPage.ts)
// and the admin CSP (#161) depend on.
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import { beforeAll, describe, expect, it } from "vitest"
import { PASSWORD_MIN } from "@gl-admin/lib/passwordRules"
import Login from "../../pages/login/index.astro"
import ForgotPassword from "../../pages/forgot-password/index.astro"
import ResetPassword from "../../pages/reset-password/index.astro"
import AcceptInvite from "../../pages/accept-invite/index.astro"

let container: AstroContainer
beforeAll(async () => {
  container = await AstroContainer.create()
})

const render = (page: Parameters<AstroContainer["renderToString"]>[0]) => container.renderToString(page)

// <script> tags with a body: the CSP's script-src has no 'unsafe-inline'.
// Astro's processed scripts are modules with a src (or, in this test build,
// empty); anything inline here would be an author's is:inline script.
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attrs, body]) => !/\bsrc=/.test(attrs) && !/type="module"/.test(attrs) && body.trim() !== "")
    .map(([tag]) => tag)
}

describe.each([
  ["/login", Login, "loginForm"],
  ["/forgot-password", ForgotPassword, "forgotForm"],
  ["/reset-password", ResetPassword, "resetForm"],
  ["/accept-invite", AcceptInvite, "acceptForm"],
] as const)("%s", (_path, page, formId) => {
  it("renders the form, the error notice and its announcer", async () => {
    const html = await render(page)
    expect(html).toContain(`id="${formId}"`)
    expect(html).toMatch(/id="errorMessage"[^>]*hidden/)
    expect(html).toContain("data-error-text")
    expect(html).toMatch(/id="errorAnnouncer"[^>]*role="alert"/)
  })

  it("keeps the existing logo and is not indexed", async () => {
    const html = await render(page)
    expect(html).toContain("gl-admin-login__logo")
    expect(html).toContain("<svg")
    expect(html).toMatch(/<meta name="robots" content="noindex/)
  })

  it("has no inline script", async () => {
    expect(inlineScripts(await render(page))).toEqual([])
  })
})

describe("password hints", () => {
  it.each([
    ["/reset-password", ResetPassword],
    ["/accept-invite", AcceptInvite],
  ] as const)("%s states the API's minimum", async (_path, page) => {
    const html = await render(page)
    expect(html).toContain(`At least ${PASSWORD_MIN} characters`)
    // Both the password and its confirmation.
    expect(html.match(new RegExp(`minlength="${PASSWORD_MIN}"`, "g"))?.length).toBe(2)
    expect(html).toMatch(/id="password"[^>]*aria-describedby="password-rule"/)
    expect(html).toMatch(/id="password-rule"[^>]*data-password-rule="password"/)
  })

  it("/reset-password can show the password", async () => {
    expect(await render(ResetPassword)).toMatch(/data-password-toggle="password"/)
  })
})

describe("expired or used links", () => {
  it.each([
    ["/reset-password", ResetPassword, "This link has expired", 'href="/forgot-password"'],
    ["/accept-invite", AcceptInvite, "This invitation has expired", 'href="/login"'],
  ] as const)("%s has its panel, hidden until needed", async (_path, page, heading, action) => {
    const html = await render(page)
    const panel = html.match(/<section[^>]*id="linkInvalid"[\s\S]*?<\/section>/)?.[0] ?? ""
    expect(panel).toMatch(/^<section[^>]*hidden/)
    expect(panel).toContain(heading)
    expect(panel).toContain(action)
  })
})

describe("/forgot-password", () => {
  it("has one confirmation, whatever the address", async () => {
    const html = await render(ForgotPassword)
    const panel = html.match(/<section[^>]*id="resetSent"[\s\S]*?<\/section>/)?.[0] ?? ""
    expect(panel).toMatch(/^<section[^>]*hidden/)
    expect(panel).toContain("If <strong")
    expect(panel).toContain('id="tryAnotherEmail"')
  })
})

describe("/accept-invite", () => {
  it("has the places the invitation preview fills in", async () => {
    const html = await render(AcceptInvite)
    for (const id of ["inviterAvatar", "inviteSummary", "roleDescription", "inviteEmail"]) {
      expect(html).toContain(`id="${id}"`)
    }
    expect(html).toMatch(/id="inviteEmail"[^>]*readonly/)
  })
})
