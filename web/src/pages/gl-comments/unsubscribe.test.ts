import type { APIContext } from "astro"
import { afterEach, describe, expect, it, vi } from "vitest"

import { POST as unsubscribe } from "./unsubscribe"
import { GET as oneClickPage, POST as oneClick } from "./unsubscribe/[token]"
import { COMMENTER_COOKIE, COMMENTER_KEY_HEADER } from "../../lib/commentWrites"
import { SERVER_MEDIA_URL } from "@gl-admin/lib/server-api-url"

// POST /gl-comments/unsubscribe (the unsubscribe page's buttons) and
// /gl-comments/unsubscribe/:token (RFC 8058's one-click, #528, design 8.2, 9.4).

const TOKEN = "t".repeat(43)

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
afterEach(() => vi.unstubAllGlobals())

function call(handler: typeof unsubscribe, path: string, init: { body: string; type?: string; headers?: Record<string, string>; params?: Record<string, string> }) {
  const url = new URL(path, "https://site.example")
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  if (init.type) headers["Content-Type"] = init.type
  const request = new Request(url, { method: "POST", headers, body: init.body })
  return handler({ request, url, params: init.params ?? {} } as unknown as APIContext) as Promise<Response>
}

describe("POST /gl-comments/unsubscribe", () => {
  const page = (body: unknown, headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin", Accept: "application/json" }) =>
    call(unsubscribe, "/gl-comments/unsubscribe", { body: JSON.stringify(body), type: "application/json", headers })

  it("forwards the token, or the token and all, and answers the API's 204", async () => {
    stubApi(204)
    const response = await page({ token: TOKEN }, { "Sec-Fetch-Site": "same-origin", Accept: "application/json", Cookie: `${COMMENTER_COOKIE}=${"k".repeat(43)}` })
    expect(response.status).toBe(204)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(calls[0].url).toBe(`${SERVER_MEDIA_URL}/public/discussion/unsubscribe`)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ token: TOKEN })
    expect(new Headers(calls[0].init.headers).get(COMMENTER_KEY_HEADER), "the browser's keys aren't needed").toBeNull()

    stubApi(204)
    expect((await page({ token: TOKEN, all: true })).status).toBe(204)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ token: TOKEN, all: true })
  })

  it("says it couldn't stop the mail when the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down") }))
    const response = await page({ token: TOKEN })
    expect(response.status).toBe(502)
    expect((await response.json()).error).toContain("stop your emails")
  })

  it("passes a dead link's 400 through for the page's invalid state", async () => {
    stubApi(400, { error: "invalid or expired token", code: "invalid_token" })
    const response = await page({ token: TOKEN })
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe("invalid_token")
  })

  it("refuses a cross-site request and a missing token without calling the API", async () => {
    stubApi(204)
    expect((await page({ token: TOKEN }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403)
    expect((await page({})).status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe("POST /gl-comments/unsubscribe/:token (RFC 8058)", () => {
  const click = (body: string, type: string, token = TOKEN, headers: Record<string, string> = {}) =>
    call(oneClick, `/gl-comments/unsubscribe/${token}`, { body, type, headers, params: { token } })

  it("works from a mail provider's server: no origin check, the form body forwarded", async () => {
    stubApi(204)
    const response = await click("List-Unsubscribe=One-Click", "application/x-www-form-urlencoded", TOKEN, { "Sec-Fetch-Site": "cross-site", Origin: "https://mail.example" })
    expect(response.status).toBe(204)
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(calls[0].url).toBe(`${SERVER_MEDIA_URL}/public/discussion/unsubscribe/${TOKEN}`)
    expect(calls[0].init.body).toBe("List-Unsubscribe=One-Click")
    expect(new Headers(calls[0].init.headers).get("content-type")).toBe("application/x-www-form-urlencoded")
  })

  it("takes the multipart form the RFC also allows", async () => {
    stubApi(204)
    const form = new FormData()
    form.set("List-Unsubscribe", "One-Click")
    const request = new Request(`https://site.example/gl-comments/unsubscribe/${TOKEN}`, { method: "POST", body: form })
    const response = await oneClick({ request, url: new URL(request.url), params: { token: TOKEN } } as unknown as APIContext)
    expect((response as Response).status).toBe(204)
  })

  it("refuses a request without the one-click body, or with a malformed token", async () => {
    stubApi(204)
    expect((await click("", "application/x-www-form-urlencoded")).status).toBe(400)
    expect((await click("List-Unsubscribe=Yes", "application/x-www-form-urlencoded")).status).toBe(400)
    expect((await click("List-Unsubscribe=One-Click", "application/x-www-form-urlencoded", "short")).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it("answers a dead link with 400 and an API failure with 502", async () => {
    stubApi(400, { code: "invalid_token" })
    expect((await click("List-Unsubscribe=One-Click", "application/x-www-form-urlencoded")).status).toBe(400)
    stubApi(500)
    expect((await click("List-Unsubscribe=One-Click", "application/x-www-form-urlencoded")).status).toBe(502)
  })
})
describe("GET /gl-comments/unsubscribe/:token (a client without RFC 8058)", () => {
  it("unsubscribes nothing and sends the reader to the page with the buttons", async () => {
    stubApi(204)
    const response = (await oneClickPage({ params: { token: TOKEN } } as unknown as APIContext)) as Response
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`/comments/unsubscribe#token=${TOKEN}`)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(calls).toHaveLength(0)
    expect(((await oneClickPage({ params: { token: "x" } } as unknown as APIContext)) as Response).status).toBe(400)
  })
})