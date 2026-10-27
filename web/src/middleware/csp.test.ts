import { describe, expect, it } from "vitest"
import { addNonceToScripts, applyAdminCsp, buildAdminCsp, isAccountPagePath, isAdminPath } from "./csp"

function directives(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/)
      return [name, values]
    }),
  )
}

describe("buildAdminCsp", () => {
  const prod = directives(
    buildAdminCsp({
      nonce: "abc",
      pageOrigin: "https://cms.example.com",
      apiUrl: "https://api.example.com/api/v1",
    }),
  )

  it("keeps script-src strict: self + nonce, no unsafe-inline/eval", () => {
    expect(prod["script-src"]).toEqual(["'self'", "'nonce-abc'"])
  })

  it("allows the API origin and the same-host collab websocket", () => {
    expect(prod["connect-src"]).toEqual(["'self'", "wss://cms.example.com", "https://api.example.com"])
    expect(prod["img-src"]).toContain("https://api.example.com")
    expect(prod["connect-src"]).not.toContain("ws://localhost:1234")
  })

  it("locks down framing, plugins, base and forms", () => {
    expect(prod["frame-ancestors"]).toEqual(["'none'"])
    expect(prod["object-src"]).toEqual(["'none'"])
    expect(prod["base-uri"]).toEqual(["'self'"])
    expect(prod["form-action"]).toEqual(["'self'"])
  })

  it("does not duplicate the API origin when it is the page origin", () => {
    const csp = directives(
      buildAdminCsp({ nonce: "n", pageOrigin: "http://localhost:4321", apiUrl: "http://localhost:4321/api/v1" }),
    )
    expect(csp["connect-src"]).toEqual(["'self'", "ws://localhost:4321"])
  })

  it("allows the page's own ws origin (dev: Vite HMR) but not the retired y-websocket port", () => {
    const dev = directives(
      buildAdminCsp({ nonce: "n", pageOrigin: "http://localhost:4321", apiUrl: "http://localhost:8080/api/v1" }),
    )
    expect(dev["connect-src"]).not.toContain("ws://localhost:1234")
    expect(dev["connect-src"]).toContain("ws://localhost:4321") // Vite HMR
  })

  it("adds the collab origin when it isn't the page's own (#206)", () => {
    const dev = directives(
      buildAdminCsp({ nonce: "n", pageOrigin: "http://127.0.0.1:4321", collabUrl: "ws://127.0.0.1:1235" }),
    )
    expect(dev["connect-src"]).toContain("ws://127.0.0.1:1235")
    // Production: wss://<host>/collab is the page's own ws origin, listed once.
    const prod = directives(
      buildAdminCsp({ nonce: "n", pageOrigin: "https://cms.example.com", collabUrl: "wss://cms.example.com/collab" }),
    )
    expect(prod["connect-src"]).toEqual(["'self'", "wss://cms.example.com"])
  })
})

describe("addNonceToScripts", () => {
  it("nonces inline and external scripts, leaving existing nonces alone", () => {
    const html = `<script>a()</script><script type="module" src="/x.js"></script><SCRIPT nonce="keep">b()</SCRIPT><noscript></noscript>`
    expect(addNonceToScripts(html, "N")).toBe(
      `<script nonce="N">a()</script><script nonce="N" type="module" src="/x.js"></script><SCRIPT nonce="keep">b()</SCRIPT><noscript></noscript>`,
    )
  })
})

describe("applyAdminCsp", () => {
  const opts = { pageOrigin: "http://localhost:4321" }

  it("sets the header and the matching nonce on HTML responses", async () => {
    const res = await applyAdminCsp(
      new Response("<script>x()</script>", { headers: { "content-type": "text/html; charset=utf-8" } }),
      opts,
    )
    const csp = res.headers.get("content-security-policy")!
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]
    expect(await res.text()).toBe(`<script nonce="${nonce}">x()</script>`)
  })

  it("uses a fresh nonce per response", async () => {
    const html = () => new Response("", { headers: { "content-type": "text/html" } })
    const a = (await applyAdminCsp(html(), opts)).headers.get("content-security-policy")
    const b = (await applyAdminCsp(html(), opts)).headers.get("content-security-policy")
    expect(a).not.toBe(b)
  })

  it("can run report-only", async () => {
    const res = await applyAdminCsp(new Response("", { headers: { "content-type": "text/html" } }), {
      ...opts,
      reportOnly: true,
    })
    expect(res.headers.get("content-security-policy")).toBeNull()
    expect(res.headers.get("content-security-policy-report-only")).toContain("script-src")
  })

  it("passes non-HTML responses through untouched", async () => {
    const original = new Response("body{}", { headers: { "content-type": "text/css" } })
    expect(await applyAdminCsp(original, opts)).toBe(original)
  })
})

describe("isAdminPath", () => {
  it("matches /gl-admin and its subpaths only", () => {
    expect(isAdminPath("/gl-admin")).toBe(true)
    expect(isAdminPath("/gl-admin/posts/1")).toBe(true)
    expect(isAdminPath("/gl-administrator")).toBe(false)
    expect(isAdminPath("/blog")).toBe(false)
  })
})

describe("isAccountPagePath", () => {
  it("covers the signed-out credential pages only", () => {
    for (const path of ["/login", "/login/", "/forgot-password", "/reset-password/", "/accept-invite"]) {
      expect(isAccountPagePath(path)).toBe(true)
    }
    for (const path of ["/", "/blog/login", "/login-help", "/reset-password/extra", "/gl-admin"]) {
      expect(isAccountPagePath(path)).toBe(false)
    }
  })
})
