import type { APIContext } from "astro"
import { SERVER_MEDIA_URL } from "@gl-admin/lib/server-api-url"
import { isSameOriginPost } from "./designPreview"
import { log } from "./log"
import { apiWriteHeaders, COMMENTER_KEY_HEADER, jsonAnswer, plainAnswer, postToApi, readFields, type ApiAnswer } from "./commentWrites"

/**
 * "Your comments" (#529, docs/design/reader-comments.md 13.2, 9.4): what the
 * `/gl-comments/data*` endpoints share. The /comments/your-data page posts to them; each
 * forwards to its `/public/discussion/data*` route at SERVER_MEDIA_URL with the browser's
 * address (the API's limits key on it) and the request id. The browser's commenter keys
 * aren't forwarded: the mailed link is the only credential here. Logs carry the route
 * pattern and the status, never the address or the token.
 */

/** The page, and the parameters its server-rendered states read (no scripts). */
export const YOUR_DATA_PAGE_PATH = "/comments/your-data"
export const YOUR_DATA_SENT_PARAM = "sent"
export const YOUR_DATA_ERROR_PARAM = "error"

/** Why a request for a link failed, for the page without scripts (`?error=`). */
export const YOUR_DATA_ERRORS: Record<string, string> = {
  email_invalid: "Enter the email address you commented with.",
  rate_limited: "Too many tries. Wait a minute and try again.",
  failed: "The site couldn't send a link just now. Try again in a moment.",
}

/** A "Your comments" link's token as the API mints it (account_tokens_utils.go): base64url. */
export function isDataToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(value)
}

/** A comment id as the page sends it: a positive integer. */
export function commentIdField(value: FormDataEntryValue | null | undefined): number | null {
  return typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : null
}

export interface DataCall {
  request: Request
  clientAddress: string | undefined
  /** The API route under /public/discussion/. */
  route: string
  body: Record<string, unknown>
}

/** Forwards a call to the API, its answer as it is (no keys, the browser's address). */
export async function callDataApi({ request, clientAddress, route, body }: DataCall): Promise<ApiAnswer> {
  const headers = apiWriteHeaders(request, clientAddress)
  headers.delete(COMMENTER_KEY_HEADER)
  const answer = await postToApi(`${SERVER_MEDIA_URL}/public/discussion/${route}`, body, headers)
  if (answer.status >= 500) log.warn("comment_data_failed", { status: answer.status })
  return answer
}

/** The API's JSON for the page's script, with this page's words for an unreachable API. */
export function dataJsonAnswer(answer: ApiAnswer, unavailable: string): Response {
  if (answer.status === 502) {
    return new Response(JSON.stringify({ error: unavailable, code: "unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
    })
  }
  return jsonAnswer(answer, { "Referrer-Policy": "no-referrer" })
}

/** The browser's address, when Astro has it (not in tests). */
export function browserAddress(context: APIContext): string | undefined {
  try {
    return context.clientAddress
  } catch {
    return undefined
  }
}

/**
 * The shape of a link endpoint (`data`, `data/delete`, `data/unsubscribe`): same-origin
 * only, a token, JSON in and out (the page needs scripts: the token is in its fragment).
 */
export async function linkEndpoint(
  context: APIContext,
  route: string,
  unavailable: string,
  extra: (fields: FormData) => Record<string, unknown> | null = () => ({}),
): Promise<Response> {
  const { request, url } = context
  if (!isSameOriginPost(request, url)) return plainAnswer(403, "Cross-site requests are refused.")
  const fields = await readFields(request)
  const token = fields?.get("token")
  if (!fields || !isDataToken(token)) return plainAnswer(400, "Expected a token.")
  const more = extra(fields)
  if (more === null) return plainAnswer(400, "Expected a comment id.")
  const answer = await callDataApi({ request, clientAddress: browserAddress(context), route, body: { token, ...more } })
  return dataJsonAnswer(answer, unavailable)
}
