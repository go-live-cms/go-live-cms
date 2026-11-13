/**
 * Cache-Control for the public site's pages (#185). One rule, applied by the middleware
 * (`withPageCacheControl`) to every public HTML response that didn't set its own header:
 *
 * - **public, max-age=60, stale-while-revalidate=300**: a 200 from a route that only ever
 *   renders published content (`CACHEABLE_PAGE_ROUTES`: the home page, post and page URLs,
 *   archives and their page N, term and author archives), for an anonymous visitor, with
 *   SITE_URL set. The API's own cache is purged on every publish; this one bounds how long
 *   a browser or a CDN in front may keep the old page (a minute, plus five while it
 *   revalidates in the background).
 * - **private, no-store** for everything else: a signed-in visitor (a session cookie: the
 *   page may differ for them, and a shared cache must never keep it), any response that
 *   sets a cookie, search (`/search?q=`: the query is the visitor's), error pages (404,
 *   500: a post published a second later must show), redirects without their own header,
 *   and every page when SITE_URL isn't set (canonical and OG URLs then come from the
 *   request's Host header, which a client controls: cache poisoning, as `cacheControl` in
 *   seo.ts). The public routes never render a draft or a preview (#393), and the admin and
 *   account pages don't come through here (account pages send no-store themselves).
 *
 * Caddy has no cache: it passes the header through to browsers and to whatever CDN sits in
 * front (docs/operations/deploy.md, "Caching").
 */
import { isSiteUrlConfigured } from "./seo"

export const PUBLIC_PAGE_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300"
export const PRIVATE_NO_STORE = "private, no-store"

// Route patterns (Astro's `context.routePattern`) that render published content only, or
// a 404. A rewrite (`/page/N/`, a term archive behind `/[post_type]/[id]`) keeps the
// pattern of the URL that was asked for, which is one of these.
export const CACHEABLE_PAGE_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/[post_type]",
  "/[post_type]/page/[n]",
  "/[post_type]/[id]",
  "/[post_type]/[id]/page/[n]",
  "/author/[username]",
  "/author/[username]/page/[n]",
])

// Cookies that mean a signed-in visitor: the refresh cookie (#159: `__Host-` when Secure,
// Path=/, so sent with every page; the dev one is scoped to /api/v1/auth) and the legacy
// `auth_token` theme functions still read.
const SESSION_COOKIES = ["__Host-refresh_token", "refresh_token", "auth_token"]

export function hasSessionCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false
  return cookieHeader.split(";").some((part) => {
    const name = part.split("=", 1)[0].trim()
    return SESSION_COOKIES.includes(name)
  })
}

export interface PageCacheInput {
  routePattern: string | undefined
  status: number
  // The request's Cookie header.
  cookie: string | null
  // Whether the response sets a cookie.
  setsCookie: boolean
  siteUrlConfigured: boolean
}

export function pageCacheControl(input: PageCacheInput): string {
  const cacheable =
    input.status === 200 &&
    input.siteUrlConfigured &&
    !input.setsCookie &&
    !hasSessionCookie(input.cookie) &&
    input.routePattern !== undefined &&
    CACHEABLE_PAGE_ROUTES.has(input.routePattern)
  return cacheable ? PUBLIC_PAGE_CACHE_CONTROL : PRIVATE_NO_STORE
}

/**
 * Sets Cache-Control on a public HTML response that has none (robots.txt, the sitemap,
 * RSS, redirects and theme assets set their own and are left alone). A signed-in visitor
 * always gets no-store, even on a response that set its own public header, and so does
 * a response that sets a cookie. Other responses pass through untouched.
 */
export function withPageCacheControl(
  response: Response,
  request: Request,
  routePattern: string | undefined,
  siteUrlConfigured: boolean = isSiteUrlConfigured(),
): Response {
  if (!(response.headers.get("content-type") || "").includes("text/html")) return response
  const cookie = request.headers.get("cookie")
  const setsCookie = response.headers.has("set-cookie")
  const own = response.headers.get("cache-control")
  if (own && !hasSessionCookie(cookie) && !setsCookie) return response
  const value = own && own.includes("no-store") ? own : pageCacheControl({ routePattern, status: response.status, cookie, setsCookie, siteUrlConfigured })
  try {
    response.headers.set("Cache-Control", value)
    return response
  } catch {
    // Immutable headers (a fetched Response passed through): copy them.
    const headers = new Headers(response.headers)
    headers.set("Cache-Control", value)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}
