import type { APIRoute } from "astro"
import { isSameOriginPost } from "../../lib/designPreview"
import { plainAnswer, readFields, seeOther, wantsJson } from "../../lib/commentWrites"
import { browserAddress, callDataApi, dataJsonAnswer, YOUR_DATA_ERROR_PARAM, YOUR_DATA_PAGE_PATH, YOUR_DATA_SENT_PARAM } from "../../lib/commentData"

export const prerender = false

/**
 * POST /gl-comments/data-request (#529, docs/design/reader-comments.md 13.2, 9.4): "Your
 * comments"' request form, `{email}`. The API answers the same 202 for any address and mails
 * a link only to one comments were written with, so this answers the same too: the API's JSON
 * for `gl-comments.js`, and without scripts (a plain form post) a 303 to the page's "Check your
 * email" (`?sent=1`), or back to the form with why (`?error=email_invalid|rate_limited|failed`).
 */
export const POST: APIRoute = async (context) => {
  const { request, url } = context
  if (!isSameOriginPost(request, url)) return plainAnswer(403, "Cross-site requests are refused.")
  const json = wantsJson(request)
  const fields = await readFields(request)
  const raw = fields?.get("email")
  const email = typeof raw === "string" ? raw.trim() : ""
  const back = (error: string) => seeOther(`${YOUR_DATA_PAGE_PATH}?${YOUR_DATA_ERROR_PARAM}=${error}`, { "Referrer-Policy": "no-referrer" })
  if (email === "" || email.length > 254) {
    if (!json) return back("email_invalid")
    return new Response(JSON.stringify({ error: "email must be a valid email address", fields: { email: "must be a valid email address" } }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    })
  }

  const answer = await callDataApi({ request, clientAddress: browserAddress(context), route: "data-request", body: { email } })
  if (json) return dataJsonAnswer(answer, "The site couldn't send a link just now. Try again in a moment.")
  if (answer.status === 202) return seeOther(`${YOUR_DATA_PAGE_PATH}?${YOUR_DATA_SENT_PARAM}=1`, { "Referrer-Policy": "no-referrer" })
  if (answer.status === 429) return back("rate_limited")
  if (answer.status === 400) return back("email_invalid")
  return back("failed")
}
