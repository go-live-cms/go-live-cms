import type { APIRoute } from "astro"
import { SERVER_MEDIA_URL } from "@gl-admin/lib/server-api-url"
import { log } from "../../../lib/log"
import { apiWriteHeaders, COMMENTER_KEY_HEADER, plainAnswer } from "../../../lib/commentWrites"

export const prerender = false

/** RFC 8058's body: the one field a one-click POST carries. */
export const ONE_CLICK_FIELD = "List-Unsubscribe"
export const ONE_CLICK_VALUE = "One-Click"
const TOKEN = /^[A-Za-z0-9_-]{20,100}$/

/**
 * POST /gl-comments/unsubscribe/:token (#528, docs/design/reader-comments.md 8.2, 9.4): the
 * RFC 8058 one-click URL in a reply mail's `List-Unsubscribe` header. **Mail providers POST
 * it from their own servers**, so unlike the other /gl-comments endpoints there is no
 * origin check: the token (32 random bytes, mailed to the reader) is the whole authority,
 * and it can only turn off the replies to one comment. The body must be
 * `List-Unsubscribe=One-Click` (urlencoded or multipart, as the RFC allows). A GET changes
 * nothing, so a link scanner can't unsubscribe anyone: a mail client without RFC 8058 opens the
 * header's URL in a browser, and GET sends it to the page with the buttons. The token is in
 * the path because the RFC requires it; logs name the route, never the path. Answers 204
 * (idempotent), 400 for a bad token or body; no cookie is read or set.
 */
export const POST: APIRoute = async (context) => {
  const { request, params } = context
  const token = params.token ?? ""
  if (!TOKEN.test(token)) return plainAnswer(400, "This unsubscribe link doesn't work.")
  let value: FormDataEntryValue | null = null
  try {
    value = (await request.formData()).get(ONE_CLICK_FIELD)
  } catch {
    value = null
  }
  if (value !== ONE_CLICK_VALUE) return plainAnswer(400, "Expected List-Unsubscribe=One-Click.")

  let clientAddress: string | undefined
  try {
    clientAddress = context.clientAddress
  } catch {
    // Not available (tests).
  }
  const headers = apiWriteHeaders(request, clientAddress)
  headers.delete(COMMENTER_KEY_HEADER)
  headers.set("Content-Type", "application/x-www-form-urlencoded")
  let status = 502
  try {
    const response = await fetch(`${SERVER_MEDIA_URL}/public/discussion/unsubscribe/${encodeURIComponent(token)}`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ [ONE_CLICK_FIELD]: ONE_CLICK_VALUE }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    status = response.status
  } catch {
    status = 502
  }
  if (status >= 500) log.warn("comment_one_click_unsubscribe_failed", { status })
  if (status === 204) return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } })
  if (status === 400) return plainAnswer(400, "This unsubscribe link doesn't work.")
  return plainAnswer(status >= 500 ? 502 : status, "The site couldn't unsubscribe you just now. Try again later.")
}
/**
 * GET /gl-comments/unsubscribe/:token: a mail client without one-click support opens the
 * List-Unsubscribe URL in a browser. Nothing is unsubscribed here; a 303 sends the reader to
 * the unsubscribe page with the token in its fragment, where the buttons spend it.
 */
export const GET: APIRoute = async ({ params }) => {
  const token = params.token ?? ""
  if (!TOKEN.test(token)) return plainAnswer(400, "This unsubscribe link doesn't work.")
  return new Response(null, {
    status: 303,
    headers: { Location: `/comments/unsubscribe#token=${token}`, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
  })
}