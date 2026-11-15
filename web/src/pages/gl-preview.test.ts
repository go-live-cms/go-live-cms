import { describe, expect, it } from "vitest"
import type { APIContext } from "astro"
import { POST } from "./gl-preview"
import { HOST_DESIGN_PREVIEW_COOKIE, DESIGN_PREVIEW_COOKIE } from "../lib/designPreview"

const TOKEN = "v4.public.eyJhdWQiOiJnb2xpdmUuZGVzaWduLXByZXZpZXcifQ_sig.eyJraWQiOiJrIn0"

function post(fields: Record<string, string>, opts: { origin?: string; site?: string; base?: string } = {}) {
  const url = new URL("/gl-preview", opts.base ?? "https://site.example")
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" }
  if (opts.site !== undefined) headers["Sec-Fetch-Site"] = opts.site
  else headers["Sec-Fetch-Site"] = "same-origin"
  if (opts.origin) headers.Origin = opts.origin
  const request = new Request(url, { method: "POST", headers, body: new URLSearchParams(fields).toString() })
  return POST({ request, url } as unknown as APIContext) as Promise<Response>
}

describe("POST /gl-preview", () => {
  it("starts a preview: sets the cookie and redirects with a GET, the token in no URL", async () => {
    const response = await post({ token: TOKEN, redirect: "/category/guides" })
    expect(response.status).toBe(303)
    expect(response.headers.get("Location")).toBe("/category/guides")
    expect(response.headers.get("Location")).not.toContain(TOKEN)
    const cookie = response.headers.get("Set-Cookie")!
    expect(cookie).toBe(`${HOST_DESIGN_PREVIEW_COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=900`)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer")
  })

  it("over plain HTTP in astro dev uses the unprefixed cookie, without Secure", async () => {
    const response = await post({ token: TOKEN, redirect: "/" }, { base: "http://localhost:4321" })
    expect(response.headers.get("Set-Cookie")).toBe(`${DESIGN_PREVIEW_COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900`)
  })

  it("Exit preview (no token) clears the cookie and goes back", async () => {
    const response = await post({ redirect: "/post/a?x=1" })
    expect(response.status).toBe(303)
    expect(response.headers.get("Location")).toBe("/post/a?x=1")
    expect(response.headers.get("Set-Cookie")).toMatch(new RegExp(`^${HOST_DESIGN_PREVIEW_COOKIE}=; .*Max-Age=0$`))
  })

  it("never redirects off the site", async () => {
    const response = await post({ token: TOKEN, redirect: "https://evil.example/" })
    expect(response.headers.get("Location")).toBe("/")
  })

  it("refuses a post from another site, and a malformed token", async () => {
    expect((await post({ token: TOKEN }, { site: "cross-site" })).status).toBe(403)
    expect((await post({ token: TOKEN }, { site: "", origin: "https://evil.example" })).status).toBe(403)
    const bad = await post({ token: "v4.local.abc" })
    expect(bad.status).toBe(400)
    expect(bad.headers.get("Set-Cookie")).toBeNull()
  })

  it("accepts a same-origin post from a browser without Sec-Fetch-Site", async () => {
    expect((await post({ token: TOKEN }, { site: "", origin: "https://site.example" })).status).toBe(303)
  })
})
