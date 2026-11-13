import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import {
  CACHEABLE_PAGE_ROUTES,
  PRIVATE_NO_STORE,
  PUBLIC_PAGE_CACHE_CONTROL,
  hasSessionCookie,
  pageCacheControl,
  withPageCacheControl,
} from "./httpCache"

const html = (status = 200, headers: Record<string, string> = {}) =>
  new Response("<!doctype html><p>x</p>", { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } })

const request = (cookie?: string) => new Request("https://site.example/blog/hello", { headers: cookie ? { Cookie: cookie } : {} })

const base = { routePattern: "/[post_type]/[id]", status: 200, cookie: null, setsCookie: false, siteUrlConfigured: true }

describe("pageCacheControl", () => {
  it("makes a published page public for anonymous visitors", () => {
    expect(PUBLIC_PAGE_CACHE_CONTROL).toBe("public, max-age=60, stale-while-revalidate=300")
    for (const routePattern of CACHEABLE_PAGE_ROUTES) {
      expect(pageCacheControl({ ...base, routePattern })).toBe(PUBLIC_PAGE_CACHE_CONTROL)
    }
  })

  it("keeps everything else out of shared caches", () => {
    expect(pageCacheControl({ ...base, status: 404 })).toBe(PRIVATE_NO_STORE)
    expect(pageCacheControl({ ...base, status: 500 })).toBe(PRIVATE_NO_STORE)
    expect(pageCacheControl({ ...base, status: 301 })).toBe(PRIVATE_NO_STORE)
    expect(pageCacheControl({ ...base, routePattern: "/search" })).toBe(PRIVATE_NO_STORE)
    expect(pageCacheControl({ ...base, routePattern: "/search/page/[n]" })).toBe(PRIVATE_NO_STORE)
    expect(pageCacheControl({ ...base, routePattern: "/users" })).toBe(PRIVATE_NO_STORE)
    expect(pageCacheControl({ ...base, routePattern: undefined })).toBe(PRIVATE_NO_STORE)
    expect(pageCacheControl({ ...base, cookie: "__Host-refresh_token=abc" })).toBe(PRIVATE_NO_STORE)
    expect(pageCacheControl({ ...base, setsCookie: true })).toBe(PRIVATE_NO_STORE)
    // Without SITE_URL the canonical URL comes from the Host header (poisoning).
    expect(pageCacheControl({ ...base, siteUrlConfigured: false })).toBe(PRIVATE_NO_STORE)
  })

  it("lists only routes that exist and render published content", () => {
    const pages = path.resolve(__dirname, "../pages")
    for (const pattern of CACHEABLE_PAGE_ROUTES) {
      const file = pattern === "/" ? "index.astro" : `${pattern.slice(1)}.astro`
      const index = pattern === "/" ? "index.astro" : `${pattern.slice(1)}/index.astro`
      expect(fs.existsSync(path.join(pages, file)) || fs.existsSync(path.join(pages, index)), pattern).toBe(true)
    }
    for (const never of ["/search", "/search/page/[n]", "/login", "/register", "/gl-admin", "/404", "/500", "/term.archive"]) {
      expect(CACHEABLE_PAGE_ROUTES.has(never), never).toBe(false)
    }
  })
})

describe("hasSessionCookie", () => {
  it("finds the refresh cookie by name only", () => {
    expect(hasSessionCookie(null)).toBe(false)
    expect(hasSessionCookie("")).toBe(false)
    expect(hasSessionCookie("theme=dark; _ga=1")).toBe(false)
    expect(hasSessionCookie("theme=dark; __Host-refresh_token=v4.local.x")).toBe(true)
    expect(hasSessionCookie("refresh_token=x")).toBe(true)
    expect(hasSessionCookie("auth_token=x")).toBe(true)
    expect(hasSessionCookie("not_refresh_token=x")).toBe(false)
    expect(hasSessionCookie("theme=refresh_token")).toBe(false)
  })
})

describe("withPageCacheControl", () => {
  it("sets the header on HTML pages that have none", () => {
    expect(withPageCacheControl(html(), request(), "/", true).headers.get("Cache-Control")).toBe(PUBLIC_PAGE_CACHE_CONTROL)
    expect(withPageCacheControl(html(404), request(), "/[post_type]/[id]", true).headers.get("Cache-Control")).toBe(PRIVATE_NO_STORE)
    expect(withPageCacheControl(html(), request("__Host-refresh_token=x"), "/", true).headers.get("Cache-Control")).toBe(PRIVATE_NO_STORE)
  })

  it("leaves a page's own header, except for signed-in visitors and cookies", () => {
    const own = "public, max-age=3600"
    expect(withPageCacheControl(html(200, { "Cache-Control": own }), request(), "/x", true).headers.get("Cache-Control")).toBe(own)
    expect(withPageCacheControl(html(200, { "Cache-Control": own }), request("refresh_token=x"), "/", true).headers.get("Cache-Control")).toBe(PRIVATE_NO_STORE)
    expect(withPageCacheControl(html(200, { "Cache-Control": own, "Set-Cookie": "a=b" }), request(), "/", true).headers.get("Cache-Control")).toBe(PRIVATE_NO_STORE)
    // A page's own no-store always stands.
    expect(withPageCacheControl(html(200, { "Cache-Control": "no-store" }), request("refresh_token=x"), "/", true).headers.get("Cache-Control")).toBe("no-store")
  })

  it("leaves non-HTML responses alone", () => {
    const json = new Response("{}", { headers: { "Content-Type": "application/json" } })
    expect(withPageCacheControl(json, request(), "/", true).headers.get("Cache-Control")).toBeNull()
  })

  it("copies immutable headers", async () => {
    // A fetched Response passed through: its headers refuse set().
    const real = html()
    const headers = new Headers(real.headers)
    const frozen = new Proxy(headers, {
      get(target, prop) {
        if (prop === "set") {
          return () => {
            throw new TypeError("immutable")
          }
        }
        const value = Reflect.get(target, prop)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const fetched = { headers: frozen, body: real.body, status: 200, statusText: "OK" } as unknown as Response
    const out = withPageCacheControl(fetched, request(), "/", true)
    expect(out).not.toBe(fetched)
    expect(out.headers.get("Cache-Control")).toBe(PUBLIC_PAGE_CACHE_CONTROL)
    expect(out.status).toBe(200)
    expect(await out.text()).toContain("<p>x</p>")
  })

  it("follows SITE_URL by default", () => {
    const saved = process.env.SITE_URL
    try {
      delete process.env.SITE_URL
      expect(withPageCacheControl(html(), request(), "/").headers.get("Cache-Control")).toBe(PRIVATE_NO_STORE)
      process.env.SITE_URL = "https://site.example"
      expect(withPageCacheControl(html(), request(), "/").headers.get("Cache-Control")).toBe(PUBLIC_PAGE_CACHE_CONTROL)
    } finally {
      if (saved === undefined) delete process.env.SITE_URL
      else process.env.SITE_URL = saved
    }
  })
})
