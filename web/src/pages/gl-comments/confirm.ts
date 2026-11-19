import type { APIRoute } from "astro"
import { SERVER_MEDIA_URL } from "@gl-admin/lib/server-api-url"
import { isSameOriginPost } from "../../lib/designPreview"
import { log } from "../../lib/log"
import {
  apiWriteHeaders,
  commenterCookieSecure,
  commenterKeys,
  commenterSetCookie,
  CONFIRM_PAGE_PATH,
  errorCodeParam,
  isCommenterKey,
  jsonAnswer,
  plainAnswer,
  postToApi,
  readFields,
  safeReturnPath,
  seeOther,
  wantsJson,
  withCommenterKey,
  withCommentedNotice,
} from "../../lib/commentWrites"

export const prerender = false

/**
 * POST /gl-comments/confirm (#524, docs/design/reader-comments.md 3.3, 9.4): the confirm
 * page's **Publish my comment** button (#525 builds the page; it reads the token from the
 * link's #fragment and posts it here). Never a GET: a link opened by a mail scanner
 * spends nothing. The API publishes or holds that comment alone and answers a browser
 * key, which becomes the `gl_commenter` cookie (Path=/gl-comments, added to the keys the
 * browser already holds, five at most). The page gets the API's JSON without the key;
 * a form post without scripts gets a 303 to the comment, or back to the confirm page with
 * `?error=`.
 */
export const POST: APIRoute = async (context) => {
  const { request, url } = context
  if (!isSameOriginPost(request, url)) return plainAnswer(403, "Cross-site requests are refused.")
  const fields = await readFields(request)
  const token = fields?.get("token")
  if (typeof token !== "string" || token === "" || token.length > 100) return plainAnswer(400, "Expected a token.")

  let clientAddress: string | undefined
  try {
    clientAddress = context.clientAddress
  } catch {
    // Not available (tests): the API then sees this server.
  }
  const answer = await postToApi(`${SERVER_MEDIA_URL}/public/discussion/confirm`, { token }, apiWriteHeaders(request, clientAddress))
  if (answer.status >= 500) log.warn("comment_confirm_failed", { status: answer.status })

  const headers: Record<string, string> = { "Referrer-Policy": "no-referrer" }
  const key = answer.body.set_key
  if (answer.status === 200 && isCommenterKey(key)) {
    headers["Set-Cookie"] = commenterSetCookie(withCommenterKey(commenterKeys(request.headers.get("cookie")), key), commenterCookieSecure(url))
  }
  if (wantsJson(request)) return jsonAnswer(answer, headers)
  if (answer.status === 200) {
    const outcome = answer.body.outcome === "published" ? "published" : "pending"
    return seeOther(withCommentedNotice(safeReturnPath(answer.body.post_url), outcome), headers)
  }
  return seeOther(`${CONFIRM_PAGE_PATH}?error=${errorCodeParam(answer)}`, headers)
}
