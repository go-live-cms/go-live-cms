import { describe, expect, it } from "vitest"
import { CROSS_SITE_POST_ROUTES, crossSiteRefusal } from "./originCheck"

// The cross-site form check (#528), Astro's checkOrigin run in our middleware so the RFC 8058
// one-click route can be exempt. The same cases as Astro's own, plus the exemption.

const SITE = "https://site.example"

function check(method: string, path: string, headers: Record<string, string>) {
  return crossSiteRefusal(new Request(SITE + path, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : "x" }), new URL(SITE + path))
}

describe("crossSiteRefusal", () => {
  it("lets safe methods and same-origin writes through", () => {
    expect(check("GET", "/", {})).toBeNull()
    expect(check("HEAD", "/", {})).toBeNull()
    expect(check("POST", "/gl-comments/confirm", { origin: SITE, "content-type": "application/x-www-form-urlencoded" })).toBeNull()
    expect(check("POST", "/gl-comments/confirm", { origin: SITE })).toBeNull()
  })

  it("refuses a cross-site form, or a write with no content type, as Astro does", async () => {
    for (const type of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain;charset=UTF-8", "Application/X-WWW-Form-Urlencoded"]) {
      const refused = check("POST", "/gl-comments/confirm", { origin: "https://evil.example", "content-type": type })
      expect(refused?.status, type).toBe(403)
      expect(await refused?.text()).toBe("Cross-site POST form submissions are forbidden")
    }
    expect(check("POST", "/gl-comments/confirm", { "content-type": "application/x-www-form-urlencoded" })?.status, "no origin").toBe(403)
    expect(check("PUT", "/x", { origin: "https://evil.example" })?.status).toBe(403)
    expect(check("DELETE", "/x", {})?.status).toBe(403)
    // A JSON write isn't a form: a browser sends it cross-site only after a CORS preflight.
    expect(check("POST", "/api/v1/posts", { origin: "https://evil.example", "content-type": "application/json" })).toBeNull()
  })

  it("exempts the RFC 8058 one-click route only, and only its POST", () => {
    const form = { "content-type": "application/x-www-form-urlencoded" }
    expect(check("POST", "/gl-comments/unsubscribe/abcDEF_-123456789012345", form)).toBeNull()
    expect(check("POST", "/gl-comments/unsubscribe/abcDEF_-123456789012345", { ...form, origin: "https://mail.example" })).toBeNull()
    expect(check("POST", "/gl-comments/unsubscribe", form)?.status, "the page's endpoint keeps the check").toBe(403)
    expect(check("POST", "/gl-comments/unsubscribe/a/b", form)?.status).toBe(403)
    expect(check("PUT", "/gl-comments/unsubscribe/abc", form)?.status).toBe(403)
    expect(CROSS_SITE_POST_ROUTES).toHaveLength(1)
  })
})