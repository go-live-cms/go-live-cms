import { describe, expect, it } from "vitest"
import { addNonceToScripts, applyAdminCsp, applyPublicCsp, buildAdminCsp, buildPublicCsp, isAccountPagePath, isAdminPath } from "./csp"
import { EMBED_PROVIDERS, embedPreviewFrame, EMBED_PROVIDER_SPECS } from "@gl-admin/lib/blocks-spec/embeds"

function directives(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/)
      return [name, values]
    }),
  )
}

describe("buildPublicCsp (#425)", () => {
  it("has one directive: frames only from the allowed providers' embed hosts", () => {
    expect(buildPublicCsp(["youtube", "vimeo"])).toBe("frame-src https://www.youtube-nocookie.com https://player.vimeo.com")
  })

  it("has no other directive, so themes' scripts, styles and fonts are unaffected", () => {
    for (const csp of [buildPublicCsp([...EMBED_PROVIDERS]), buildPublicCsp([])]) {
      expect(csp).not.toContain(";")
      expect(Object.keys(directives(csp))).toEqual(["frame-src"])
    }
  })

  it("allows no frame at all when no provider is allowed", () => {
    expect(buildPublicCsp([])).toBe("frame-src 'none'")
  })

  it("names X's widget frame host only while X is allowed", () => {
    expect(buildPublicCsp(["x"])).toBe("frame-src https://platform.twitter.com")
    expect(buildPublicCsp(["youtube"])).not.toContain("twitter")
  })

  it("covers every player the table can build, and never a host of another provider", () => {
    for (const provider of EMBED_PROVIDERS) {
      const ref = { youtube: "dQw4w9WgXcQ", vimeo: "76979871", x: "20", codepen: "a/b1", soundcloud: "a/b", spotify: "track/4cOdK2wGLETKBW3PvgPWqT" }[provider]
      const frame = EMBED_PROVIDER_SPECS[provider].frame?.(ref) ?? embedPreviewFrame(provider, ref)
      expect(buildPublicCsp([provider]).split(" ")).toContain(new URL(frame.src).origin)
    }
  })
})

describe("applyPublicCsp (#425)", () => {
  it("sets the header on an HTML page and keeps the rest of the response", async () => {
    const response = new Response("<p>Hello</p>", { status: 404, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } })
    const applied = applyPublicCsp(response, ["youtube"])
    expect(applied.headers.get("Content-Security-Policy")).toBe("frame-src https://www.youtube-nocookie.com")
    expect(applied.headers.get("x-robots-tag")).toBe("noindex")
    expect(applied.status).toBe(404)
    expect(await applied.text()).toBe("<p>Hello</p>")
  })

  it("leaves anything else alone", () => {
    const response = new Response("{}", { headers: { "content-type": "application/json" } })
    expect(applyPublicCsp(response, ["youtube"])).toBe(response)
  })

  it("works on a fetched response, whose headers are immutable", () => {
    const response = Response.redirect("https://example.com/")
    expect(() => applyPublicCsp(new Response(null, { status: 204, headers: response.headers }), [])).not.toThrow()
  })
})

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
    // #423: the editor's players load /uploads like the images.
    expect(prod["media-src"]).toEqual(["'self'", "https://api.example.com"])
    expect(prod["connect-src"]).not.toContain("ws://localhost:1234")
  })

  it("frames only the embed providers' players, and keeps X's widget script out (#425)", () => {
    expect(prod["frame-src"]).toEqual([
      "https://www.youtube-nocookie.com",
      "https://player.vimeo.com",
      "https://platform.twitter.com",
      "https://codepen.io",
      "https://w.soundcloud.com",
      "https://open.spotify.com",
    ])
    expect(prod["script-src"]).not.toContain("https://platform.twitter.com")
  })

  it("allows same-origin workers only: History's bundled diff worker, no blob:/data: (#355)", () => {
    expect(prod["worker-src"]).toEqual(["'self'"])
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
    for (const path of ["/login", "/login/", "/forgot-password", "/reset-password/", "/accept-invite", "/confirm-email", "/register", "/verify-email/"]) {
      expect(isAccountPagePath(path)).toBe(true)
    }
    for (const path of ["/", "/blog/login", "/login-help", "/reset-password/extra", "/gl-admin"]) {
      expect(isAccountPagePath(path)).toBe(false)
    }
  })
})
