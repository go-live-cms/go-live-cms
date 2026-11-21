import type { APIContext } from "astro"
import { afterEach, describe, expect, it, vi } from "vitest"

import { POST as dataRequest } from "./data-request"
import { POST as data } from "./data"
import { POST as dataDelete } from "./data/delete"
import { POST as dataUnsubscribe } from "./data/unsubscribe"
import { COMMENTER_COOKIE, COMMENTER_KEY_HEADER } from "../../lib/commentWrites"
import { commentIdField, isDataToken } from "../../lib/commentData"
import { log } from "../../lib/log"
import { SERVER_MEDIA_URL } from "@gl-admin/lib/server-api-url"

// "Your comments"' endpoints (#529, docs/design/reader-comments.md 13.2, 9.4):
// /gl-comments/data-request (the request form, with and without scripts), /data, /data/delete
// and /data/unsubscribe (the link's page, JSON only).

const TOKEN = "t".repeat(43)
const SAME = { "Sec-Fetch-Site": "same-origin" }
const JSON_SAME = { ...SAME, Accept: "application/json" }

let calls: { url: string; init: RequestInit }[] = []
function stubApi(status: number, body: unknown = {}) {
  calls = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    }),
  )
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type Handler = (context: APIContext) => Response | Promise<Response>
function call(handler: Handler, path: string, body: string, type: string, headers: Record<string, string>) {
  const url = new URL(path, "https://site.example")
  const request = new Request(url, { method: "POST", headers: { "Content-Type": type, ...headers }, body })
  return Promise.resolve(handler({ request, url, params: {} } as unknown as APIContext))
}
const postJson = (handler: Handler, path: string, body: unknown, headers: Record<string, string> = JSON_SAME) =>
  call(handler, path, JSON.stringify(body), "application/json", headers)

describe("POST /gl-comments/data-request", () => {
  it("forwards the address with the browser's request, never its commenter keys, and answers the API's 202", async () => {
    stubApi(202, { outcome: "link_sent" })
    const response = await postJson(dataRequest, "/gl-comments/data-request", { email: "  jonas@example.com " }, { ...JSON_SAME, Cookie: `${COMMENTER_COOKIE}=${"k".repeat(43)}` })
    expect(response.status).toBe(202)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(await response.json()).toEqual({ outcome: "link_sent" })
    expect(calls[0].url).toBe(`${SERVER_MEDIA_URL}/public/discussion/data-request`)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ email: "jonas@example.com" })
    expect(new Headers(calls[0].init.headers).get(COMMENTER_KEY_HEADER)).toBeNull()
  })

  it("without scripts: a plain form post goes to Check your email, or back to the form with why", async () => {
    stubApi(202, { outcome: "link_sent" })
    const form = (body: string) => call(dataRequest, "/gl-comments/data-request", body, "application/x-www-form-urlencoded", SAME)
    let response = await form("email=jonas%40example.com")
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/comments/your-data?sent=1")
    expect(response.headers.get("cache-control")).toBe("private, no-store")

    stubApi(429, { error: "too many requests" })
    expect((await form("email=jonas%40example.com")).headers.get("location")).toBe("/comments/your-data?error=rate_limited")
    stubApi(400, { error: "email must be a valid email address" })
    expect((await form("email=nope")).headers.get("location")).toBe("/comments/your-data?error=email_invalid")
    stubApi(500)
    expect((await form("email=jonas%40example.com")).headers.get("location")).toBe("/comments/your-data?error=failed")
    stubApi(202)
    response = await form("email=")
    expect(response.headers.get("location")).toBe("/comments/your-data?error=email_invalid")
    expect(calls, "an empty address never reaches the API").toHaveLength(0)
  })

  it("an unreachable API is this page's 502, logged by status only", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down") }))
    const response = await postJson(dataRequest, "/gl-comments/data-request", { email: "jonas@example.com" })
    expect(response.status).toBe(502)
    expect((await response.json()).error).toContain("send a link")
    expect(warn).toHaveBeenCalledWith("comment_data_failed", { status: 502 })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("jonas")
  })

  it("refuses a cross-site request without calling the API", async () => {
    stubApi(202)
    expect((await postJson(dataRequest, "/gl-comments/data-request", { email: "jonas@example.com" }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403)
    expect(calls).toHaveLength(0)
  })
})

describe("the link's endpoints", () => {
  it("POST /gl-comments/data forwards the token and answers the file", async () => {
    const file = { commenter: { email: "jonas@example.com" }, comments: [], subscriptions: [] }
    stubApi(200, file)
    const response = await postJson(data, "/gl-comments/data", { token: TOKEN })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(await response.json()).toEqual(file)
    expect(calls[0].url).toBe(`${SERVER_MEDIA_URL}/public/discussion/data`)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ token: TOKEN })
  })

  it("POST /gl-comments/data/delete: one comment by id, or everything", async () => {
    stubApi(204)
    expect((await postJson(dataDelete, "/gl-comments/data/delete", { token: TOKEN, comment_id: 3 })).status).toBe(204)
    expect(calls[0].url).toBe(`${SERVER_MEDIA_URL}/public/discussion/data/delete`)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ token: TOKEN, comment_id: 3 })
    stubApi(204)
    expect((await postJson(dataDelete, "/gl-comments/data/delete", { token: TOKEN })).status).toBe(204)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ token: TOKEN })
    stubApi(404, { code: "comment_not_found" })
    expect((await postJson(dataDelete, "/gl-comments/data/delete", { token: TOKEN, comment_id: 9 })).status).toBe(404)
    stubApi(204)
    expect((await postJson(dataDelete, "/gl-comments/data/delete", { token: TOKEN, comment_id: "x" })).status).toBe(400)
    expect((await postJson(dataDelete, "/gl-comments/data/delete", { token: TOKEN, comment_id: -1 })).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it("POST /gl-comments/data/unsubscribe is Stop all mail", async () => {
    stubApi(204)
    expect((await postJson(dataUnsubscribe, "/gl-comments/data/unsubscribe", { token: TOKEN })).status).toBe(204)
    expect(calls[0].url).toBe(`${SERVER_MEDIA_URL}/public/discussion/data/unsubscribe`)
  })

  it("pass a dead link's 400 through, and refuse cross-site requests and bad tokens without calling the API", async () => {
    stubApi(400, { code: "invalid_token" })
    const dead = await postJson(data, "/gl-comments/data", { token: TOKEN })
    expect(dead.status).toBe(400)
    expect((await dead.json()).code).toBe("invalid_token")
    stubApi(204)
    for (const handler of [data, dataDelete, dataUnsubscribe]) {
      expect((await postJson(handler, "/gl-comments/data", { token: TOKEN }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403)
      expect((await postJson(handler, "/gl-comments/data", {})).status).toBe(400)
      expect((await postJson(handler, "/gl-comments/data", { token: "a b" })).status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })

  it("an unreachable API is a 502 in the page's words", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down") }))
    const response = await postJson(dataUnsubscribe, "/gl-comments/data/unsubscribe", { token: TOKEN })
    expect(response.status).toBe(502)
    expect((await response.json()).error).toContain("stop your emails")
  })
})

describe("the field rules", () => {
  it("a token is the API's base64url; a comment id a positive integer", () => {
    expect(isDataToken(TOKEN)).toBe(true)
    expect(isDataToken("short")).toBe(false)
    expect(isDataToken("t".repeat(101))).toBe(false)
    expect(isDataToken("a+b/c=" + "t".repeat(40))).toBe(false)
    expect(commentIdField("12")).toBe(12)
    expect(commentIdField("0")).toBeNull()
    expect(commentIdField("1e3")).toBeNull()
    expect(commentIdField("9007199254740993"), "past 2^53 it would round to another id").toBeNull()
    expect(commentIdField(null)).toBeNull()
  })
})
