import type { APIRoute } from "astro"
import {
  designPreviewCookieSecure,
  designPreviewSetCookie,
  isPreviewTokenShape,
  isSameOriginPost,
  safePreviewRedirect,
} from "../lib/designPreview"
import { PRIVATE_NO_STORE } from "../lib/httpCache"

export const prerender = false

/**
 * POST /gl-preview (#486, docs/design/theme-builder.md 8.3): starts or ends a design
 * preview. A form post from this site:
 *
 * - `token` (a preview token from `POST /api/v1/site-design/preview`) and `redirect`:
 *   sets the preview cookie and sends the browser to `redirect`. The token is in the body
 *   only, never in a URL (a GET is not accepted), and it is not checked here: the API
 *   checks it, and who holds it, on every page read with it.
 * - no `token` (the banner's Exit preview): clears the cookie and goes back to `redirect`.
 *
 * 303 either way, so the browser follows with a GET. 403 for a post from anywhere else, so
 * no other site can start or end someone's preview; 400 for a malformed token.
 */
export const POST: APIRoute = async ({ request, url }) => {
  if (!isSameOriginPost(request, url)) {
    return plain(403, "Cross-site preview requests are refused.")
  }
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return plain(400, "Expected a form.")
  }
  const token = form.get("token")
  const secure = designPreviewCookieSecure(url)
  let cookie: string
  if (token === null || token === "") {
    cookie = designPreviewSetCookie(null, secure)
  } else if (isPreviewTokenShape(token)) {
    cookie = designPreviewSetCookie(token, secure)
  } else {
    return plain(400, "Invalid preview token.")
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: safePreviewRedirect(form.get("redirect")),
      "Set-Cookie": cookie,
      "Cache-Control": PRIVATE_NO_STORE,
      "Referrer-Policy": "no-referrer",
    },
  })
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": PRIVATE_NO_STORE } })
}
