import type { APIRoute } from "astro"
import { SERVER_MEDIA_URL } from "@gl-admin/lib/server-api-url"
import { isSameOriginPost } from "../../lib/designPreview"
import { log } from "../../lib/log"
import { apiWriteHeaders, COMMENTER_KEY_HEADER, jsonAnswer, plainAnswer, postToApi, readFields } from "../../lib/commentWrites"

export const prerender = false

/**
 * POST /gl-comments/unsubscribe (#528, docs/design/reader-comments.md 8.2, 9.4): the
 * /comments/unsubscribe page's buttons. The page reads the token from the reply mail's
 * `#token=` link and posts `{token}` (**Stop these emails**: that comment's replies) or
 * `{token, all: true}` (**Stop all mail from this site**: every subscription of the
 * commenter). The token is the whole authority, and it can only stop mail. The page needs
 * scripts (the token is in the fragment), so the answer is always the API's JSON: 204, or
 * 400 `invalid_token` for a link that doesn't work any more. The browser's commenter keys
 * aren't forwarded: nothing here needs them.
 */
export const POST: APIRoute = async (context) => {
  const { request, url } = context
  if (!isSameOriginPost(request, url)) return plainAnswer(403, "Cross-site requests are refused.")
  const fields = await readFields(request)
  const token = fields?.get("token")
  if (typeof token !== "string" || token === "" || token.length > 100) return plainAnswer(400, "Expected a token.")
  const all = fields?.get("all") === "true"

  let clientAddress: string | undefined
  try {
    clientAddress = context.clientAddress
  } catch {
    // Not available (tests): the API then sees this server.
  }
  const headers = apiWriteHeaders(request, clientAddress)
  headers.delete(COMMENTER_KEY_HEADER)
  const answer = await postToApi(`${SERVER_MEDIA_URL}/public/discussion/unsubscribe`, all ? { token, all: true } : { token }, headers)
  if (answer.status >= 500) log.warn("comment_unsubscribe_failed", { status: answer.status })
  if (answer.status === 502) {
    // jsonAnswer's 502 speaks of posting a comment; this page stops mail.
    return new Response(JSON.stringify({ error: "The site couldn't stop your emails just now. Try again in a moment.", code: "unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
    })
  }
  return jsonAnswer(answer, { "Referrer-Policy": "no-referrer" })
}