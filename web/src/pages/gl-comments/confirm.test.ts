import type { APIContext } from "astro"
import { afterEach, describe, expect, it, vi } from "vitest"

import { POST as confirm } from "./confirm"
import { POST as unconfirmed } from "./unconfirmed/[id]"
import { COMMENTER_COOKIE, COMMENTER_KEY_HEADER } from "../../lib/commentWrites"
import { SERVER_MEDIA_URL } from "@gl-admin/lib/server-api-url"

// POST /gl-comments/confirm and /gl-comments/unconfirmed/:id (#524, design 3.3, 9.4):
// the confirm page's buttons. The key the API answers becomes the gl_commenter cookie,
// scoped to /gl-comments, and never reaches the page's script.

const OLD = "o".repeat(43)
const NEW = "n".repeat(43)
const TOKEN = "t".repeat(43)

let calls: { url: string; init: RequestInit }[] = []
function stubApi(status: number, body: unknown) {
  calls = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    }),
  )
}
afterEach(() => vi.unstubAllGlobals())

function call(handler: typeof confirm, path: string, body: Record<string, string>, opts: { json?: boolean; site?: string; cookie?: string; params?: Record<string, string> } = {}) {
  const url = new URL(path, "https://site.example")
  const headers: Record<string, string> = { "Sec-Fetch-Site": opts.site ?? "same-origin" }
  if (opts.cookie) headers.Cookie = opts.cookie
  let payload: string
  if (opts.json) {
    headers["Content-Type"] = "application/json"
    headers.Accept = "application/json"
    payload = JSON.stringify(body)
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded"
    payload = new URLSearchParams(body).toString()
  }
  const request = new Request(url, { method: "POST", headers, body: payload })
  return handler({ request, url, params: opts.params ?? {} } as unknown as APIContext) as Promise<Response>
}

describe("POST /gl-comments/confirm", () => {
  const published = { outcome: "published", comment_id: 7, post_url: "/post/hello", comment_url: "/post/hello#comment-7", set_key: NEW, others: [] }

  it("sets the key beside the browser's others, scoped to the endpoints, and keeps it from the script", async () => {
    stubApi(200, published)
    const response = await call(confirm, "/gl-comments/confirm", { token: TOKEN }, { json: true, cookie: `${COMMENTER_COOKIE}=${OLD}` })
    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toBe(`${COMMENTER_COOKIE}=${OLD}.${NEW}; Path=/gl-comments; HttpOnly; SameSite=Lax; Secure; Max-Age=31536000`)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    const body = await response.json()
    expect(body).not.toHaveProperty("set_key")
    expect(JSON.stringify(body)).not.toContain(NEW)
    expect(calls[0].url).toBe(`${SERVER_MEDIA_URL}/public/discussion/confirm`)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ token: TOKEN })
  })

  it("without scripts goes to the comment with the notice", async () => {
    stubApi(200, published)
    const response = await call(confirm, "/gl-comments/confirm", { token: TOKEN })
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/post/hello?commented=published#comment-form")
    expect(response.headers.get("set-cookie")).toContain("Path=/gl-comments")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
  })

  it("a refused link sets no cookie", async () => {
    stubApi(400, { error: "this link is invalid or has expired", code: "invalid_token" })
    const json = await call(confirm, "/gl-comments/confirm", { token: TOKEN }, { json: true })
    expect(json.status).toBe(400)
    expect(json.headers.get("set-cookie")).toBeNull()
    const form = await call(confirm, "/gl-comments/confirm", { token: TOKEN })
    expect(form.status).toBe(303)
    expect(form.headers.get("location")).toBe("/comments/confirm?error=invalid_token")
  })

  it("an answer without a well-formed key sets no cookie", async () => {
    stubApi(200, { ...published, set_key: "short" })
    expect((await call(confirm, "/gl-comments/confirm", { token: TOKEN }, { json: true })).headers.get("set-cookie")).toBeNull()
  })

  it("refuses another site and a missing token, without calling the API", async () => {
    stubApi(200, published)
    expect((await call(confirm, "/gl-comments/confirm", { token: TOKEN }, { site: "cross-site" })).status).toBe(403)
    expect((await call(confirm, "/gl-comments/confirm", {})).status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe("POST /gl-comments/unconfirmed/:id", () => {
  it("publishes with the browser's keys", async () => {
    stubApi(200, { outcome: "published", comment_id: 9, post_url: "/post/other", comment_url: "/post/other#comment-9" })
    const response = await call(unconfirmed, "/gl-comments/unconfirmed/9", { action: "publish" }, { json: true, cookie: `${COMMENTER_COOKIE}=${OLD}`, params: { id: "9" } })
    expect(response.status).toBe(200)
    expect(calls[0].url).toBe(`${SERVER_MEDIA_URL}/public/discussion/unconfirmed/9`)
    expect(new Headers(calls[0].init.headers).get(COMMENTER_KEY_HEADER)).toBe(OLD)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ action: "publish" })
  })

  it("discards, without scripts back to the confirm page", async () => {
    stubApi(204, null)
    const response = await call(unconfirmed, "/gl-comments/unconfirmed/9", { action: "discard" }, { params: { id: "9" } })
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/comments/confirm?discarded=1")
    const json = await call(unconfirmed, "/gl-comments/unconfirmed/9", { action: "discard" }, { json: true, params: { id: "9" } })
    expect(json.status).toBe(204)
  })

  it("refuses another site, a bad id and an unknown action", async () => {
    stubApi(200, {})
    expect((await call(unconfirmed, "/gl-comments/unconfirmed/9", { action: "publish" }, { site: "cross-site", params: { id: "9" } })).status).toBe(403)
    expect((await call(unconfirmed, "/gl-comments/unconfirmed/x", { action: "publish" }, { params: { id: "x" } })).status).toBe(404)
    expect((await call(unconfirmed, "/gl-comments/unconfirmed/9", { action: "approve" }, { params: { id: "9" } })).status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})
