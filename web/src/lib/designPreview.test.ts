import { afterEach, describe, expect, it, vi } from "vitest"
import { JSDOM } from "jsdom"
import {
  DESIGN_PREVIEW_COOKIE,
  HOST_DESIGN_PREVIEW_COOKIE,
  designPreviewBannerHtml,
  designPreviewCookieSecure,
  designPreviewSetCookie,
  designPreviewToken,
  injectDesignPreviewBanner,
  isPreviewTokenShape,
  isPreviewablePath,
  isSameOriginPost,
  loadDesignDraft,
  safePreviewRedirect,
  withClearedDesignPreviewCookie,
  withDesignPreview,
} from "./designPreview"
import { hasSessionCookie, pageCacheControl, PRIVATE_NO_STORE, withPageCacheControl } from "./httpCache"
import { log } from "./log"
import { NO_GLOBAL_STYLES } from "./themeTokens"

const TOKEN = "v4.public.eyJhdWQiOiJnb2xpdmUuZGVzaWduLXByZXZpZXcifQ_sig-Part.eyJraWQiOiJrIn0"

afterEach(() => vi.restoreAllMocks())

describe("the preview cookie", () => {
  it("is Secure outside astro dev, and in dev only over HTTPS", () => {
    expect(designPreviewCookieSecure(new URL("http://web:4321/"), false)).toBe(true)
    expect(designPreviewCookieSecure(new URL("https://site.example/"), false)).toBe(true)
    expect(designPreviewCookieSecure(new URL("https://localhost:4321/"), true)).toBe(true)
    expect(designPreviewCookieSecure(new URL("http://localhost:4321/"), true)).toBe(false)
  })

  it("is HttpOnly, SameSite=Strict, Path=/ and 15 minutes; __Host- whenever it is Secure", () => {
    expect(designPreviewSetCookie(TOKEN, true)).toBe(`${HOST_DESIGN_PREVIEW_COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=900`)
    expect(designPreviewSetCookie(TOKEN, false)).toBe(`${DESIGN_PREVIEW_COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900`)
    expect(designPreviewSetCookie(null, true)).toBe(`${HOST_DESIGN_PREVIEW_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`)
  })

  it("is read by this mode's name only, and only with a token's shape", () => {
    expect(designPreviewToken(`a=b; ${HOST_DESIGN_PREVIEW_COOKIE}=${TOKEN}`, true)).toBe(TOKEN)
    expect(designPreviewToken(`${DESIGN_PREVIEW_COOKIE}=${TOKEN}`, true)).toBeNull()
    expect(designPreviewToken(`${DESIGN_PREVIEW_COOKIE}=${TOKEN}`, false)).toBe(TOKEN)
    expect(designPreviewToken(`${HOST_DESIGN_PREVIEW_COOKIE}=not-a-token`, true)).toBeNull()
    expect(designPreviewToken(`x${HOST_DESIGN_PREVIEW_COOKIE}=${TOKEN}`, true)).toBeNull()
    expect(designPreviewToken(null, true)).toBeNull()
  })

  it("makes every page asked for with it uncacheable, accepted or not (design 11)", () => {
    for (const name of [HOST_DESIGN_PREVIEW_COOKIE, DESIGN_PREVIEW_COOKIE]) {
      expect(hasSessionCookie(`${name}=x`)).toBe(true)
      expect(pageCacheControl({ routePattern: "/", status: 200, cookie: `${name}=x`, setsCookie: false, siteUrlConfigured: true })).toBe(PRIVATE_NO_STORE)
    }
  })
})

describe("isPreviewTokenShape", () => {
  it("accepts a v4.public token and nothing else", () => {
    expect(isPreviewTokenShape(TOKEN)).toBe(true)
    expect(isPreviewTokenShape("v4.public.abc")).toBe(true)
    for (const bad of ["", "v4.local.abc", "v4.public.", "v4.public.a b", "v4.public.a;b", `v4.public.${"a".repeat(5000)}`, 42, null]) {
      expect(isPreviewTokenShape(bad)).toBe(false)
    }
  })
})

describe("isPreviewablePath", () => {
  it("previews the public site, not the admin, the API, uploads, theme files or the endpoint", () => {
    for (const path of ["/", "/category/guides", "/post/hello", "/search", "/gl-adminx", "/apis"]) expect(isPreviewablePath(path)).toBe(true)
    for (const path of ["/gl-admin", "/gl-admin/site", "/api/v1/posts", "/uploads/media/x.jpg", "/themes/default/styles/theme.css", "/gl-preview"]) {
      expect(isPreviewablePath(path)).toBe(false)
    }
  })
})

describe("safePreviewRedirect", () => {
  it("keeps a path on this site with its query and fragment", () => {
    expect(safePreviewRedirect("/category/guides?page=2#top")).toBe("/category/guides?page=2#top")
    expect(safePreviewRedirect("/")).toBe("/")
  })

  it("sends anything else home", () => {
    for (const bad of [null, "", "https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)", "/a\nb", "/gl-admin", "/gl-preview", "relative", 7]) {
      expect(safePreviewRedirect(bad)).toBe("/")
    }
  })
})

describe("isSameOriginPost", () => {
  const url = new URL("https://site.example/gl-preview")
  const post = (headers: Record<string, string>) => new Request(url, { method: "POST", headers })

  it("trusts Sec-Fetch-Site, else compares Origin with the host", () => {
    expect(isSameOriginPost(post({ "Sec-Fetch-Site": "same-origin" }), url)).toBe(true)
    expect(isSameOriginPost(post({ "Sec-Fetch-Site": "cross-site", Origin: "https://site.example" }), url)).toBe(false)
    expect(isSameOriginPost(post({ "Sec-Fetch-Site": "same-site" }), url)).toBe(false)
    expect(isSameOriginPost(post({ Origin: "https://site.example" }), url)).toBe(true)
    expect(isSameOriginPost(post({ Origin: "https://evil.example" }), url)).toBe(false)
    expect(isSameOriginPost(post({ Origin: "null" }), url)).toBe(false)
    expect(isSameOriginPost(post({}), url)).toBe(false)
  })
})

describe("loadDesignDraft", () => {
  const answer = (status: number, body?: unknown) =>
    vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))

  it("reads the draft with the token as bearer", async () => {
    const fetcher = answer(200, { theme: "default", global_styles: { colors: { light: { primary: "#225544" } } }, expires_at: "2026-11-15T10:15:00Z" })
    const result = await loadDesignDraft(TOKEN, fetcher as unknown as typeof fetch)
    expect(result).toEqual({
      status: "ok",
      draft: { theme: "default", globalStyles: { colors: { light: { primary: "#225544" } } }, expiresAt: "2026-11-15T10:15:00Z" },
    })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/site-design\/draft$/)
    expect(url).not.toContain(TOKEN)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it("an empty or malformed draft is no override", async () => {
    const result = await loadDesignDraft(TOKEN, answer(200, { theme: "default", global_styles: "nope" }) as unknown as typeof fetch)
    expect(result.status === "ok" && result.draft.globalStyles).toEqual(NO_GLOBAL_STYLES)
  })

  it("an expired, a demoted admin's or another theme's token is refused", async () => {
    for (const status of [401, 403, 409]) {
      expect(await loadDesignDraft(TOKEN, answer(status, { error: "x" }) as unknown as typeof fetch)).toEqual({ status: "refused" })
    }
  })

  it("an API that can't answer leaves the published design, and no log line has the token", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {})
    expect(await loadDesignDraft(TOKEN, answer(500) as unknown as typeof fetch)).toEqual({ status: "unavailable" })
    expect(await loadDesignDraft(TOKEN, answer(200, { nope: true }) as unknown as typeof fetch)).toEqual({ status: "unavailable" })
    const down = vi.fn(async () => {
      throw new TypeError(`fetch failed for Bearer ${TOKEN}`)
    })
    expect(await loadDesignDraft(TOKEN, down as unknown as typeof fetch)).toEqual({ status: "unavailable" })
    expect(warn).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN.slice(10, 40))
  })
})

describe("the banner", () => {
  const page = `<!doctype html><html lang="en"><head><title>T</title></head><body class="x"><div class="site"><a href="#content" class="skip-link">Skip to content</a><header>H</header></div></body></html>`

  it("is the first thing in the body, above the header", () => {
    const html = injectDesignPreviewBanner(page, "/post/a")
    const doc = new JSDOM(html).window.document
    const first = doc.body.firstElementChild!
    expect(first.tagName).toBe("STYLE")
    const banner = first.nextElementSibling!
    expect(banner.className).toBe("gl-preview-banner")
    expect(banner.nextElementSibling!.className).toBe("site")
  })

  it("is a labelled region with Exit preview, a plain POST form, reachable by keyboard", () => {
    const doc = new JSDOM(`<body>${designPreviewBannerHtml("/category/guides?page=2")}</body>`).window.document
    const banner = doc.querySelector(".gl-preview-banner")!
    expect(banner.getAttribute("role")).toBe("region")
    expect(banner.getAttribute("aria-label")).toBe("Design preview")
    expect(banner.textContent).toContain("Previewing unpublished design · only you can see it")
    const form = banner.querySelector("form")!
    expect(form.getAttribute("method")).toBe("post")
    expect(form.getAttribute("action")).toBe("/gl-preview")
    expect((form.querySelector('input[name="redirect"]') as HTMLInputElement).value).toBe("/category/guides?page=2")
    expect(form.querySelector('input[name="token"]')).toBeNull()
    const button = form.querySelector("button")!
    expect(button.getAttribute("type")).toBe("submit")
    expect(button.textContent).toBe("Exit preview")
    expect(button.hasAttribute("tabindex")).toBe(false)
  })

  it("uses core's fixed colours, never the theme's tokens", () => {
    const css = designPreviewBannerHtml("/").match(/<style>(.*)<\/style>/)![1]
    expect(css).toContain("background:#1c2024")
    expect(css).not.toContain("var(")
  })

  it("escapes where Exit leads", () => {
    expect(designPreviewBannerHtml('/a?q="><script>alert(1)</script>')).not.toContain("<script>")
  })

  it("leaves a page without a body alone", () => {
    expect(injectDesignPreviewBanner("<p>fragment</p>", "/")).toBe("<p>fragment</p>")
  })
})

describe("withDesignPreview", () => {
  it("makes a previewed page private, no-store and noindex, with the banner", async () => {
    const page = new Response("<html><body><main>M</main></body></html>", {
      headers: { "Content-Type": "text/html; charset=utf-8", "Content-Length": "40" },
    })
    const response = await withDesignPreview(page, "/")
    expect(response.headers.get("Cache-Control")).toBe(PRIVATE_NO_STORE)
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow")
    expect(response.headers.get("Content-Length")).toBeNull()
    expect(await response.text()).toMatch(/^<html><body><style>.*<div class="gl-preview-banner"/)
  })

  it("keeps that no-store through the page cache rule, for a cacheable route", async () => {
    const page = await withDesignPreview(new Response("<body></body>", { headers: { "Content-Type": "text/html" } }), "/")
    const request = new Request("https://site.example/", { headers: { Cookie: `${HOST_DESIGN_PREVIEW_COOKIE}=${TOKEN}` } })
    expect(withPageCacheControl(page, request, "/", true).headers.get("Cache-Control")).toBe(PRIVATE_NO_STORE)
  })

  it("gives a response that isn't HTML the headers only", async () => {
    const response = await withDesignPreview(new Response(null, { status: 301, headers: { Location: "/b" } }), "/a")
    expect(response.status).toBe(301)
    expect(response.headers.get("Location")).toBe("/b")
    expect(response.headers.get("Cache-Control")).toBe(PRIVATE_NO_STORE)
  })
})

describe("withClearedDesignPreviewCookie", () => {
  it("adds the clearing Set-Cookie and keeps the page's own", () => {
    const page = new Response("x", { headers: { "Set-Cookie": "a=b" } })
    const cookies = withClearedDesignPreviewCookie(page, true).headers.getSetCookie()
    expect(cookies).toEqual(["a=b", `${HOST_DESIGN_PREVIEW_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`])
  })
})
