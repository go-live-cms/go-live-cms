import type { APIRoute } from "astro"
import { SERVER_MEDIA_URL } from "@gl-admin/lib/server-api-url"
import { isSameOriginPost } from "../../../lib/designPreview"
import { log } from "../../../lib/log"
import {
  apiWriteHeaders,
  CONFIRM_PAGE_PATH,
  errorCodeParam,
  jsonAnswer,
  plainAnswer,
  postToApi,
  readFields,
  seeOther,
  wantsJson,
  withCommentedNotice,
  safeReturnPath,
} from "../../../lib/commentWrites"

export const prerender = false

/**
 * POST /gl-comments/unconfirmed/:id (#524, design 3.3 step 5): the confirm page's
 * **Publish** and **Discard** on the address's other unconfirmed comments, one at a time,
 * authorized by the browser key the confirmation just set (the cookie reaches this path).
 * `action` is `publish` or `discard`. JSON for the page's script; without scripts a 303
 * back to the confirm page (or to the published comment).
 */
export const POST: APIRoute = async (context) => {
  const { request, url, params } = context
  if (!isSameOriginPost(request, url)) return plainAnswer(403, "Cross-site requests are refused.")
  const id = params.id ?? ""
  if (!/^[1-9][0-9]{0,17}$/.test(id)) return plainAnswer(404, "Comment not found.")
  const fields = await readFields(request)
  const action = fields?.get("action")
  if (action !== "publish" && action !== "discard") return plainAnswer(400, "Expected an action.")

  let clientAddress: string | undefined
  try {
    clientAddress = context.clientAddress
  } catch {
    // Not available (tests).
  }
  const answer = await postToApi(`${SERVER_MEDIA_URL}/public/discussion/unconfirmed/${id}`, { action }, apiWriteHeaders(request, clientAddress))
  if (answer.status >= 500) log.warn("comment_unconfirmed_action_failed", { status: answer.status })
  if (wantsJson(request)) return jsonAnswer(answer)
  if (answer.status === 200) {
    const outcome = answer.body.outcome === "published" ? "published" : "pending"
    return seeOther(withCommentedNotice(safeReturnPath(answer.body.post_url), outcome))
  }
  if (answer.status === 204) return seeOther(`${CONFIRM_PAGE_PATH}?discarded=1`)
  return seeOther(`${CONFIRM_PAGE_PATH}?error=${errorCodeParam(answer)}`)
}
