/**
 * The site's comment write endpoints (#524, docs/design/reader-comments.md 9.4): the rules
 * the `/gl-comments/*` routes share. The API's comment writes are under `/public`, which
 * browsers can't reach (the production proxy forwards `/api/v1` and `/uploads` only), so a
 * plain HTML form posts to the site's own endpoint, which:
 *
 * 1. refuses a cross-origin browser request (`Sec-Fetch-Site`, else `Origin` against the
 *    site's host: `isSameOriginPost`, as `/gl-preview` does);
 * 2. maps the form (`COMMENT_FORM_FIELDS`) to the API's JSON, forwarding the browser's
 *    address in X-Forwarded-For (`appendForwardedFor`, as the API proxy does), the request
 *    id, and the `gl_commenter` cookie's keys as `GoLive-Commenter-Key`;
 * 3. sets the cookie from a confirmation's `set_key` (`Path=/gl-comments`: it reaches
 *    these endpoints only, never a page, so pages stay the same for everyone and cacheable);
 * 4. answers a browser without scripts with a 303 back to the post
 *    (`?commented=pending|published|confirm#comment-form`), or, on a refusal, a short page
 *    with the reason and the typed text to copy; `gl-comments.js` (#525) sends
 *    `Accept: application/json` and gets the API's JSON instead (never `set_key`).
 *
 * Every answer is `private, no-store`. Logs carry the route pattern and the status, never
 * the form, the cookie or the key.
 */
import { requestIdHeaders } from "./log"
import { appendForwardedFor } from "../middleware/apiProxy"
import { PRIVATE_NO_STORE } from "./httpCache"
import { designPreviewCookieSecure } from "./designPreview"
import { COMMENT_CODE_REASONS, COMMENT_FORM_FIELDS, COMMENTED_PARAM } from "./commentFormFields"

/** The browser key's cookie (3.3): one value listing up to five keys, `.`-separated. */
export const COMMENTER_COOKIE = "gl_commenter"
/** Only the write endpoints receive it: never a page request (design problem 5). */
export const COMMENTER_COOKIE_PATH = "/gl-comments"
export const COMMENTER_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60
export const COMMENTER_KEYS_MAX = 5
/** The header the API reads the keys from (api/discussion_write.go). */
export const COMMENTER_KEY_HEADER = "GoLive-Commenter-Key"
// A key is 32 random bytes, base64url without padding, like the API's emailed tokens.
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** The comment form's field names, which the comments section (#525) renders. */
export { COMMENT_FORM_FIELDS, COMMENTED_PARAM }

/** The outcomes the API answers and the notice parameter carries. */
export type CommentOutcome = "confirm_email" | "pending" | "published"
const NOTICE_VALUE: Record<CommentOutcome, string> = { confirm_email: "confirm", pending: "pending", published: "published" }

export function isCommenterKey(value: unknown): value is string {
  return typeof value === "string" && KEY_PATTERN.test(value)
}

/** The keys in a Cookie header's `gl_commenter`, well-formed ones only, at most five. */
export function commenterKeys(cookieHeader: string | null): string[] {
  if (!cookieHeader) return []
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.split("=")
    if (name.trim() !== COMMENTER_COOKIE) continue
    return rest.join("=").trim().split(".").filter(isCommenterKey).slice(-COMMENTER_KEYS_MAX)
  }
  return []
}

/** The keys with a new one added last; an old copy of it dropped, the oldest past five too. */
export function withCommenterKey(keys: readonly string[], key: string): string[] {
  return [...keys.filter((k) => k !== key), key].slice(-COMMENTER_KEYS_MAX)
}

/**
 * The cookie's `Set-Cookie`: HttpOnly, SameSite=Lax, a year, `Path=/gl-comments`, and
 * Secure except in `astro dev` over plain HTTP (designPreviewCookieSecure's rule).
 */
export function commenterSetCookie(keys: readonly string[], secure: boolean): string {
  const parts = [`${COMMENTER_COOKIE}=${keys.filter(isCommenterKey).join(".")}`, `Path=${COMMENTER_COOKIE_PATH}`, "HttpOnly", "SameSite=Lax"]
  if (secure) parts.push("Secure")
  parts.push(`Max-Age=${COMMENTER_COOKIE_MAX_AGE_SECONDS}`)
  return parts.join("; ")
}

/** Whether the cookie gets Secure: the design preview cookie's rule (#486), one definition. */
export const commenterCookieSecure = designPreviewCookieSecure

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === "string" ? value : ""
}

/** The API's JSON for a comment form (`POST /public/posts/:id/comments`). */
export function commentRequestBody(form: FormData): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: field(form, COMMENT_FORM_FIELDS.name),
    email: field(form, COMMENT_FORM_FIELDS.email).trim(),
    body: field(form, COMMENT_FORM_FIELDS.body),
    notify_replies: ["1", "on", "true", "yes"].includes(field(form, COMMENT_FORM_FIELDS.notifyReplies)),
    website: field(form, COMMENT_FORM_FIELDS.website),
  }
  const parent = field(form, COMMENT_FORM_FIELDS.parentId).trim()
  if (/^[1-9][0-9]{0,17}$/.test(parent)) body.parent_id = Number(parent)
  return body
}

/** A path on this site to go back to (`/…`, never `//…` or a backslash), else `fallback`. */
export function safeReturnPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) {
    return fallback
  }
  try {
    const url = new URL(value, "http://site.invalid")
    // "/.//evil.example/x" normalizes to the path "//evil.example/x": a link off the site.
    if (url.origin !== "http://site.invalid" || url.pathname.startsWith("//")) return fallback
    return `${url.pathname}${url.search}`
  } catch {
    return fallback
  }
}

/** `path` with the outcome's notice (`?commented=`) and the form's anchor. */
export function withCommentedNotice(path: string, outcome: CommentOutcome): string {
  const url = new URL(safeReturnPath(path), "http://site.invalid")
  url.hash = ""
  // The form is done: no more "Replying to …".
  url.searchParams.delete("replyto")
  url.searchParams.set(COMMENTED_PARAM, NOTICE_VALUE[outcome])
  return `${url.pathname}${url.search}#comment-form`
}

/** Whether the caller wants the API's JSON (gl-comments.js) rather than a page or a redirect. */
export function wantsJson(request: Request): boolean {
  return (request.headers.get("accept") || "").includes("application/json")
}

/** The headers of a call to the API's /public writes on the browser's behalf. */
export function apiWriteHeaders(request: Request, clientAddress: string | undefined): Headers {
  const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json" })
  appendForwardedFor(headers, request.headers, clientAddress)
  for (const [name, value] of Object.entries(requestIdHeaders())) headers.set(name, value)
  const keys = commenterKeys(request.headers.get("cookie"))
  if (keys.length > 0) headers.set(COMMENTER_KEY_HEADER, keys.join(", "))
  const agent = request.headers.get("user-agent")
  if (agent) headers.set("User-Agent", agent)
  return headers
}

export interface ApiAnswer {
  status: number
  body: Record<string, unknown>
  retryAfter: string | null
}

/** POSTs `body` to the API; an unreachable API is a 502 answer with no body. */
export async function postToApi(url: string, body: unknown, headers: Headers, fetchImpl: typeof fetch = fetch): Promise<ApiAnswer> {
  let response: Response
  try {
    response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(10_000) })
  } catch {
    return { status: 502, body: {}, retryAfter: null }
  }
  let parsed: unknown = {}
  try {
    parsed = response.status === 204 ? {} : await response.json()
  } catch {
    parsed = {}
  }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  return { status: response.status, body: record, retryAfter: response.headers.get("retry-after") }
}

/** A JSON answer, `no-store`. `set_key` never reaches the browser's scripts: it is the cookie. */
export function jsonAnswer(answer: ApiAnswer, extraHeaders: Record<string, string> = {}): Response {
  const { set_key: _key, ...body } = answer.body
  const headers: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": PRIVATE_NO_STORE, ...extraHeaders }
  if (answer.retryAfter) headers["Retry-After"] = answer.retryAfter
  const status = answer.status === 502 ? 502 : answer.status
  const payload = answer.status === 502 ? { error: "The site couldn't take your comment just now.", code: "unavailable" } : body
  return new Response(answer.status === 204 ? null : JSON.stringify(payload), { status, headers })
}

export function seeOther(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": PRIVATE_NO_STORE, ...extraHeaders } })
}

export interface CommentRefusal {
  /** 422 for anything the reader can fix or that refuses the post, 429 for limits, 503 when the site couldn't answer. */
  status: number
  reason: string
}

const FIELD_REASONS: Record<string, string> = {
  name_required: "Add your name.",
  name_too_long: "Your name is too long: 60 characters at most.",
  name_invalid: "Your name must be one line of plain text.",
  body_too_short: "Your comment is too short: write at least 2 characters.",
  body_too_long: "Your comment is too long: 4,000 characters at most.",
  body_invalid: "Your comment has characters that can't be shown. Remove them and try again.",
}

const CODE_REASONS = COMMENT_CODE_REASONS

/** Why the API refused, in the reader's words (the form states board's wording). */
export function commentRefusal(answer: ApiAnswer): CommentRefusal {
  const code = typeof answer.body.code === "string" ? answer.body.code : ""
  if (answer.status === 429) {
    return { status: 429, reason: CODE_REASONS[code] ?? "You're commenting too fast. Wait a minute and try again." }
  }
  if (answer.status >= 500) {
    return { status: 503, reason: "The site couldn't take your comment just now. Try again in a moment." }
  }
  if (FIELD_REASONS[code]) return { status: 422, reason: FIELD_REASONS[code] }
  if (CODE_REASONS[code]) return { status: 422, reason: CODE_REASONS[code] }
  const fields = answer.body.fields && typeof answer.body.fields === "object" ? Object.keys(answer.body.fields) : []
  if (fields.includes("email")) return { status: 422, reason: "Check your email address." }
  if (fields.length > 0) return { status: 422, reason: "Check the form and try again." }
  return { status: 422, reason: "Your comment couldn't be posted." }
}

/**
 * The most a comment endpoint reads of a request body: the API takes 24 KiB of JSON
 * (api/request_limits.go), and a form-encoded 4000-character comment of emoji is about
 * three times its UTF-8 size. A longer body isn't read at all.
 */
export const COMMENT_BODY_MAX_BYTES = 96 * 1024

/** The body as text, or null past `max` bytes (read in chunks, never buffered whole). */
async function readLimitedText(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > max) return null
  if (!request.body) return ""
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * The request's fields: a urlencoded form (what an HTML form sends) or a JSON object, at
 * most COMMENT_BODY_MAX_BYTES; null for anything else (multipart included).
 */
export async function readFields(request: Request): Promise<FormData | null> {
  const type = (request.headers.get("content-type") || "").toLowerCase()
  const json = type.includes("application/json")
  if (!json && !type.includes("application/x-www-form-urlencoded")) return null
  try {
    const text = await readLimitedText(request, COMMENT_BODY_MAX_BYTES)
    if (text === null) return null
    const form = new FormData()
    if (!json) {
      for (const [name, value] of new URLSearchParams(text)) form.set(name, value)
      return form
    }
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") form.set(name, String(value))
    }
    return form
  } catch {
    return null
  }
}

/** A short plain answer for a refused request (cross-site, malformed), `no-store`. */
export function plainAnswer(status: number, text: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": PRIVATE_NO_STORE, ...extraHeaders } })
}

/** An API error code fit for a URL (`[a-z_]`), else "failed". */
export function errorCodeParam(answer: ApiAnswer): string {
  const code = answer.body.code
  return typeof code === "string" && /^[a-z][a-z_]{0,39}$/.test(code) ? code : "failed"
}

/** The confirm page (11.6, #525), where a refused confirmation without scripts lands. */
export const CONFIRM_PAGE_PATH = "/comments/confirm"
