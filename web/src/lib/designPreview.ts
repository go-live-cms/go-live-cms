/**
 * Design preview (#486, docs/design/theme-builder.md 8.3, 11 and 12): an admin sees the
 * site with the unpublished design while every other visitor gets the published one.
 *
 * 1. The admin gets a preview token from the API (`POST /site-design/preview`: PASETO v4,
 *    audience `golive.design-preview`, 15 minutes) and posts it to `POST /gl-preview`
 *    (`src/pages/gl-preview.ts`), a form post, so the token is in the body and never in
 *    a URL, a proxy log or a `Referer`.
 * 2. That sets the HttpOnly, Secure, SameSite=Strict preview cookie and redirects.
 * 3. On each public page while the cookie is there, the middleware reads the draft from
 *    `GET /site-design/draft` with the token as bearer (`loadDesignDraft`). The API
 *    checks the token and that its user is **still an admin**, so a demoted admin's
 *    cookie stops working at once. Any other answer renders the published site.
 * 4. A page rendered with the draft is `private, no-store`, `X-Robots-Tag: noindex`, and
 *    starts with the preview banner (`withDesignPreview`). Any page requested with the
 *    cookie is never cached (httpCache.ts), whatever the API said.
 *
 * The token never reaches a log line: nothing here logs it, the request id is the only
 * header the API calls carry besides it, and log.ts scrubs credential-named fields.
 */
import { SERVER_API_URL } from "../../gl-admin/lib/server-api-url"
import { log, requestIdHeaders } from "./log"
import { PRIVATE_NO_STORE } from "./httpCache"
import { DESIGN_PREVIEW_COOKIE, HOST_DESIGN_PREVIEW_COOKIE } from "./designPreviewCookie"
import { publishedGlobalStyles, type GlobalStyles } from "./themeTokens"

export { DESIGN_PREVIEW_COOKIE, HOST_DESIGN_PREVIEW_COOKIE } from "./designPreviewCookie"

/** How long the cookie lives: the token's own lifetime (the API's designPreviewTTL). */
export const DESIGN_PREVIEW_MAX_AGE_SECONDS = 15 * 60

/** The endpoint that starts and ends a preview. */
export const DESIGN_PREVIEW_PATH = "/gl-preview"

// A preview token as the API mints it: v4.public, base64url body, an optional footer. The
// endpoint stores nothing else in the cookie.
const PREVIEW_TOKEN_PATTERN = /^v4\.public\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/
const PREVIEW_TOKEN_MAX_LENGTH = 4096

/** Whether a posted value has the shape of a preview token (the API verifies the rest). */
export function isPreviewTokenShape(value: unknown): value is string {
  return typeof value === "string" && value.length <= PREVIEW_TOKEN_MAX_LENGTH && PREVIEW_TOKEN_PATTERN.test(value)
}

/**
 * Whether the preview cookie gets `Secure`, which also decides its name. Always outside
 * `astro dev`, like the API's refresh cookie outside GIN_MODE=debug (production sits
 * behind Caddy's TLS, which Astro may see as plain HTTP). In `astro dev` only over HTTPS:
 * a plain-HTTP dev site can't keep a Secure cookie in every browser (Safari refuses one
 * from http://localhost), which is the same reason the dev refresh cookie isn't Secure.
 */
export function designPreviewCookieSecure(url: URL, dev: boolean = import.meta.env.DEV): boolean {
  return !dev || url.protocol === "https:"
}

export function designPreviewCookieName(secure: boolean): string {
  return secure ? HOST_DESIGN_PREVIEW_COOKIE : DESIGN_PREVIEW_COOKIE
}

/** The `Set-Cookie` that starts a preview (`token`) or ends one (`null`). */
export function designPreviewSetCookie(token: string | null, secure: boolean): string {
  const parts = [`${designPreviewCookieName(secure)}=${token ?? ""}`, "Path=/", "HttpOnly", "SameSite=Strict"]
  if (secure) parts.push("Secure")
  parts.push(token ? `Max-Age=${DESIGN_PREVIEW_MAX_AGE_SECONDS}` : "Max-Age=0")
  return parts.join("; ")
}

/** The preview token from a Cookie header, or null. Only the name for this mode counts. */
export function designPreviewToken(cookieHeader: string | null, secure: boolean): string | null {
  if (!cookieHeader) return null
  const name = designPreviewCookieName(secure)
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=")
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue
    const value = part.slice(eq + 1).trim()
    return isPreviewTokenShape(value) ? value : null
  }
  return null
}

// Paths a preview never applies to: the admin, the account pages, the API, uploads, theme
// assets and the preview endpoint itself.
const NOT_PREVIEWED_PREFIXES = ["/gl-admin", "/api/", "/uploads/", "/themes/", DESIGN_PREVIEW_PATH]

/** Whether a page at this path renders with the draft while previewing. */
export function isPreviewablePath(pathname: string): boolean {
  return !NOT_PREVIEWED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))
}

/**
 * Where `POST /gl-preview` sends the browser: a path on this site that a preview applies
 * to, with its query and fragment, else `/`. Never another origin, a protocol-relative
 * `//host` or a backslash trick.
 */
export function safePreviewRedirect(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return "/"
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return "/"
  try {
    const base = "http://preview.invalid"
    const target = new URL(value, base)
    if (target.origin !== base || !isPreviewablePath(target.pathname)) return "/"
    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return "/"
  }
}

/**
 * Whether a browser form post comes from this site: `Sec-Fetch-Site: same-origin` when
 * the browser sends it, else an `Origin` whose host is the request's (the API's
 * cookieOriginGuard does the same). A post with neither is refused: every browser that can
 * run the admin sends one of them.
 */
export function isSameOriginPost(request: Request, url: URL): boolean {
  const site = request.headers.get("sec-fetch-site")
  if (site) return site === "same-origin"
  const origin = request.headers.get("origin")
  if (!origin || origin === "null") return false
  try {
    return new URL(origin).host === url.host
  } catch {
    return false
  }
}

/**
 * The draft a preview renders, as `GET /site-design/draft` answers it. One key per kind of
 * design item: global styles today; #492 adds templates and parts beside them.
 */
export interface DesignDraft {
  theme: string
  globalStyles: GlobalStyles
  expiresAt: string | null
}

export type DesignDraftResult =
  | { status: "ok"; draft: DesignDraft }
  // The API refused the token (expired, not an admin any more, another theme active):
  // the cookie is useless, so the middleware clears it.
  | { status: "refused" }
  // The API couldn't answer: the page renders published, and the cookie stays.
  | { status: "unavailable" }

// A page waits this long for the draft before rendering the published design.
const DRAFT_TIMEOUT_MS = 3000

/** Reads the draft with the preview token as bearer. Never throws, never logs the token. */
export async function loadDesignDraft(token: string, fetcher: typeof fetch = fetch): Promise<DesignDraftResult> {
  let response: Response
  try {
    response = await fetcher(`${SERVER_API_URL}/site-design/draft`, {
      headers: { Authorization: `Bearer ${token}`, ...requestIdHeaders() },
      signal: AbortSignal.timeout(DRAFT_TIMEOUT_MS),
    })
  } catch (error) {
    log.warn("design_preview_draft_failed", { reason: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "fetch_failed" })
    return { status: "unavailable" }
  }
  if (response.status === 401 || response.status === 403 || response.status === 409) {
    return { status: "refused" }
  }
  if (!response.ok) {
    log.warn("design_preview_draft_failed", { status: response.status })
    return { status: "unavailable" }
  }
  try {
    const body = await response.json()
    if (!body || typeof body.theme !== "string") throw new Error("no theme in the draft")
    return {
      status: "ok",
      draft: {
        theme: body.theme,
        // The same reading as the published override: anything but an object is none.
        globalStyles: publishedGlobalStyles(body.global_styles),
        expiresAt: typeof body.expires_at === "string" ? body.expires_at : null,
      },
    }
  } catch {
    log.warn("design_preview_draft_failed", { reason: "invalid_body" })
    return { status: "unavailable" }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)
}

/**
 * The banner's CSS: core's own fixed colours, never the theme's tokens (they are what is
 * being previewed and may fail contrast), from the default theme canvas's board. Every
 * rule is scoped to `.gl-preview-banner` and sets what a theme's element rules could
 * change (margins, fonts, button looks).
 */
export const DESIGN_PREVIEW_BANNER_CSS = [
  ".gl-preview-banner{position:relative;z-index:20;box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;min-height:44px;margin:0;padding:6px 16px;background:#1c2024;color:#ffffff;font:500 14px/20px system-ui,-apple-system,\"Segoe UI\",sans-serif;letter-spacing:normal;text-transform:none;text-align:left}",
  ".gl-preview-banner p{margin:0;flex:1 1 220px;color:#ffffff;font:inherit}",
  ".gl-preview-banner span{color:#b0b4ba;font-weight:400}",
  ".gl-preview-banner form{margin:0;padding:0}",
  ".gl-preview-banner button{box-sizing:border-box;min-height:32px;margin:0;padding:0 12px;border:1px solid #696e77;border-radius:6px;background:transparent;color:#ffffff;font:inherit;letter-spacing:normal;text-transform:none;box-shadow:none;cursor:pointer}",
  ".gl-preview-banner button:hover{background:#ffffff1f}",
  ".gl-preview-banner button:focus-visible{outline:2px solid #ffffff;outline-offset:2px}",
].join("")

/**
 * The banner's markup (`gl-preview-banner`, the canvas's board): a labelled region, so a
 * screen reader lists it as a landmark and reads it first (it is the first thing in the
 * page), and Exit preview, a plain POST form that works without scripts and is the page's
 * first Tab stop. `returnTo` is where Exit leads (this page).
 */
export function designPreviewBannerHtml(returnTo: string): string {
  return (
    `<style>${DESIGN_PREVIEW_BANNER_CSS}</style>` +
    `<div class="gl-preview-banner" role="region" aria-label="Design preview">` +
    `<p>Previewing unpublished design <span>· only you can see it</span></p>` +
    `<form method="post" action="${DESIGN_PREVIEW_PATH}">` +
    `<input type="hidden" name="redirect" value="${escapeHtml(safePreviewRedirect(returnTo))}">` +
    `<button type="submit">Exit preview</button>` +
    `</form></div>`
  )
}

/**
 * Puts the banner right after `<body …>`, in the page's flow above the header. The search
 * starts after `</head>`, so a `<body` inside a head script or comment is never the spot.
 */
export function injectDesignPreviewBanner(html: string, returnTo: string): string {
  const headEnd = html.search(/<\/head\s*>/i)
  const from = headEnd < 0 ? 0 : headEnd
  const bodyTag = /<body\b[^>]*>/gi
  bodyTag.lastIndex = from
  const body = bodyTag.exec(html)
  if (!body) return html
  const at = body.index + body[0].length
  return html.slice(0, at) + designPreviewBannerHtml(returnTo) + html.slice(at)
}

/** A request's preview, as the middleware keeps it in `locals.designPreview`. */
export interface DesignPreviewState {
  state: "previewing" | "refused" | "off"
  expiresAt: string | null
  applied: boolean
  /**
   * While previewing (#493): reads the working templates and parts with this request's token
   * (`siteTemplates.ts` `readDraftSiteDesign`). A closure, so the token itself is never on locals.
   */
  readTemplates?: import("./siteTemplates").SiteTemplateReader
}

/**
 * Finishes a page for the request's preview: the banner and headers when previewing, the
 * cleared cookie when the API refused the token. Once per request: Astro.rewrite runs the
 * middleware again with the same locals, and the rewritten page the inner pass finished is
 * what the outer pass returns.
 */
export async function finishDesignPreview(
  page: Response,
  preview: DesignPreviewState | undefined,
  returnTo: string,
  secure: boolean,
): Promise<Response> {
  if (!preview || preview.applied || preview.state === "off") return page
  preview.applied = true
  return preview.state === "previewing" ? withDesignPreview(page, returnTo) : withClearedDesignPreviewCookie(page, secure)
}

/** Adds the `Set-Cookie` that ends the preview (the API refused its token). */
export function withClearedDesignPreviewCookie(response: Response, secure: boolean): Response {
  const headers = new Headers(response.headers)
  headers.append("Set-Cookie", designPreviewSetCookie(null, secure))
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * A page rendered with the draft: never cached, never indexed, and an HTML page gets the
 * banner. Other responses (a redirect, a feed) get the headers only.
 */
export async function withDesignPreview(response: Response, returnTo: string): Promise<Response> {
  const headers = new Headers(response.headers)
  headers.set("Cache-Control", PRIVATE_NO_STORE)
  headers.set("X-Robots-Tag", "noindex, nofollow")
  if (!(headers.get("content-type") || "").includes("text/html") || !response.body) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
  const html = injectDesignPreviewBanner(await response.text(), returnTo)
  headers.delete("content-length")
  return new Response(html, { status: response.status, statusText: response.statusText, headers })
}
