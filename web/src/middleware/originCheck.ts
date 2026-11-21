/**
 * The cross-site form check (CSRF) Astro 5 runs as `security.checkOrigin`, run here instead so
 * one route can be exempt (#528). astro.config.mjs turns Astro's own off; this is the same rule
 * (Astro 5.16's createOriginCheckMiddleware): an unsafe method whose `Origin` isn't this URL's
 * origin is refused when it carries a form-like content type, or none at all.
 *
 * The exemption: **RFC 8058 one-click unsubscribe**, `POST /gl-comments/unsubscribe/:token`.
 * Mail providers POST it from their own servers, with their origin or none, so the check would
 * refuse every one. Its token (32 random bytes, mailed to the reader) is the whole authority,
 * and it can only turn off the reply mail of one comment (design 8.2), so a forged request can
 * do nothing a reader would mind. Every other /gl-comments endpoint still checks the origin
 * itself too (`isSameOriginPost`).
 */
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"]
const FORM_CONTENT_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]

/** POST routes any origin may call, with why: each one's credential is in the request itself. */
export const CROSS_SITE_POST_ROUTES: { pattern: RegExp; reason: string }[] = [
  { pattern: /^\/gl-comments\/unsubscribe\/[^/]+\/?$/, reason: "RFC 8058 one-click from mail providers' servers; the mailed token can only stop reply mail" },
]

/** A 403 for a cross-site form submission, or null to go on. */
export function crossSiteRefusal(request: Request, url: URL): Response | null {
  if (SAFE_METHODS.includes(request.method)) return null
  if (request.method === "POST" && CROSS_SITE_POST_ROUTES.some((route) => route.pattern.test(url.pathname))) return null
  const sameOrigin = request.headers.get("origin") === url.origin
  if (sameOrigin) return null
  const contentType = request.headers.get("content-type")
  if (contentType !== null) {
    const type = contentType.toLowerCase()
    if (!FORM_CONTENT_TYPES.some((form) => type.includes(form))) return null
  }
  return new Response(`Cross-site ${request.method} form submissions are forbidden`, { status: 403 })
}