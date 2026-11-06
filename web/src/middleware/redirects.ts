/**
 * Redirects (#331): Settings › URLs & redirects, and the ones the API adds when a public
 * URL changes (a published post's or a term's slug, a tag merge). A site page that
 * answers 404 asks the API where its address went (GET /public/redirects?path=) and
 * answers that 301/302 instead. Only a 404 asks, so a redirect never hides a live page,
 * and pages that exist cost no lookup. Tested in redirects.test.ts.
 */
import { getPublic } from "../lib/publicApi"
import { log } from "../lib/log"

export interface RedirectTarget {
  to_path: string
  status_code: number
}

// Not the public site's pages: the admin, the API proxy and the files the web serves.
const SKIPPED_PREFIXES = ["/gl-admin", "/api/", "/uploads/", "/themes/", "/_astro/"]

export function lookupRedirect(path: string): Promise<RedirectTarget | null> {
  return getPublic<RedirectTarget>(`/redirects?path=${encodeURIComponent(path)}`)
}

// The Location for target: a site path keeps the request's query (and gets its
// non-ASCII characters escaped); an absolute URL is used as stored.
export function redirectLocation(target: string, requestUrl: URL): string {
  if (!target.startsWith("/")) return target
  const url = new URL(target, requestUrl.origin)
  if (!url.search && requestUrl.search) url.search = requestUrl.search
  return `${url.pathname}${url.search}`
}

export async function redirectOn404(
  request: Request,
  url: URL,
  response: Response,
  lookup: (path: string) => Promise<RedirectTarget | null> = lookupRedirect,
): Promise<Response> {
  if (response.status !== 404 || (request.method !== "GET" && request.method !== "HEAD")) return response
  if (SKIPPED_PREFIXES.some((prefix) => url.pathname === prefix.replace(/\/$/, "") || url.pathname.startsWith(prefix))) {
    return response
  }
  let target: RedirectTarget | null
  try {
    target = await lookup(url.pathname)
  } catch (error) {
    // The 404 stands: a redirect lookup must never turn it into an error page.
    log.warn("redirect_lookup_failed", { error })
    return response
  }
  if (!target?.to_path) return response
  const status = target.status_code === 302 ? 302 : 301
  return new Response(null, {
    status,
    headers: {
      Location: redirectLocation(target.to_path, url),
      // A permanent redirect may be cached a while; an admin can still delete it.
      "Cache-Control": status === 301 ? "public, max-age=3600" : "no-cache",
    },
  })
}
