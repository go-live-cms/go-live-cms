// POST /gl-comments/posts/:id (#524, docs/design/reader-comments.md 9.4), rendered by
// Astro's container: the comment form works end to end without scripts. A form post is
// mapped to the API's JSON and answered with a 303 back to the post (?commented=), or with
// the refusal page that keeps the typed text; a script gets the API's JSON. Cross-site
// posts and GETs are refused, nothing is cached, and nothing of the form is logged.
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/siteSettings", () => ({
  getSiteSettings: async () => ({ title: "Field Notes", tagline: "", language: "en" }),
}))

const Endpoint = (await import("./posts/[id].astro")).default
const { SERVER_MEDIA_URL } = await import("@gl-admin/lib/server-api-url")
const { log } = await import("@/lib/log")
const { COMMENTER_COOKIE, COMMENTER_KEY_HEADER } = await import("@/lib/commentWrites")

const SITE = "https://site.example"
const KEY = "k".repeat(43)
const TYPED = "My <b>thoughts</b> & a </textarea><script>alert(1)</script>"

type ApiReply = { status: number; body?: unknown; headers?: Record<string, string> }
let calls: { url: string; init: RequestInit }[] = []

function stubApi(reply: ApiReply | Error) {
  calls = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      if (reply instanceof Error) throw reply
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json", ...reply.headers },
      })
    }),
  )
}

let container: AstroContainer
beforeEach(async () => {
  container = await AstroContainer.create()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

interface PostOptions {
  fields?: Record<string, string>
  headers?: Record<string, string>
  method?: string
  id?: string
}

function submit({ fields, headers = {}, method = "POST", id = "42" }: PostOptions = {}) {
  const body = new URLSearchParams(
    fields ?? { comment: TYPED, name: "Maya", email: "maya@example.com", notify_replies: "1", website: "", return_to: "/post/hello?comments=2" },
  )
  const request = new Request(`${SITE}/gl-comments/posts/${id}`, {
    method,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin", ...headers },
    body: method === "GET" ? undefined : body.toString(),
  })
  return container.renderToResponse(Endpoint, { request, params: { id }, locals: { activeTheme: "default" } as App.Locals })
}

describe("POST /gl-comments/posts/:id without scripts", () => {
  it("maps the form, calls the API with the browser's address and keys, and redirects back with the notice", async () => {
    stubApi({ status: 202, body: { outcome: "confirm_email", post_url: "/post/hello" } })
    const response = await submit({ headers: { "X-Forwarded-For": "203.0.113.7", Cookie: `${COMMENTER_COOKIE}=${KEY}; theme=dark` } })

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/post/hello?comments=2&commented=confirm#comment-form")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("set-cookie")).toBeNull()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${SERVER_MEDIA_URL}/public/posts/42/comments`)
    expect(calls[0].init.method).toBe("POST")
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: "Maya", email: "maya@example.com", body: TYPED, notify_replies: true, website: "" })
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.7")
    expect(headers.get(COMMENTER_KEY_HEADER)).toBe(KEY)
    expect(headers.get("cookie")).toBeNull()
  })

  it.each([
    [201, "published"],
    [202, "pending"],
  ])("a %i %s goes back with its notice", async (status, outcome) => {
    stubApi({ status, body: { outcome, post_url: "/post/hello", comment_id: 7 } })
    const response = await submit({ fields: { comment: "Hi there", name: "Maya", email: "maya@example.com", parent_id: "3", return_to: "/post/hello?replyto=3" } })
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`/post/hello?commented=${outcome}#comment-form`)
    expect(JSON.parse(String(calls[0].init.body)).parent_id).toBe(3)
  })

  it("goes back to the post the API names when the form doesn't say", async () => {
    stubApi({ status: 202, body: { outcome: "confirm_email", post_url: "/post/hello" } })
    const response = await submit({ fields: { comment: "Hi there", name: "Maya", email: "maya@example.com", return_to: "https://evil.example/" } })
    expect(response.headers.get("location")).toBe("/post/hello?commented=confirm#comment-form")
  })

  it("a refusal answers a page with the reason and the typed text to copy, escaped", async () => {
    stubApi({ status: 409, body: { error: "comments on this post are closed", code: "comments_closed" } })
    const response = await submit()
    expect(response.status).toBe(422)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    const html = await response.text()
    expect(html).toContain("Your comment wasn")
    expect(html).toContain("Comments on this post are closed.")
    expect(html).toMatch(/<textarea[^>]*readonly[^>]*>My &lt;b&gt;thoughts&lt;\/b&gt; &amp; a &lt;\/textarea&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/textarea>/)
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain('href="/post/hello?comments=2"')
    expect(html).toContain("Back to the post")
    expect(html).toMatch(/<meta name="robots" content="noindex/)
  })

  it("a field refusal says which", async () => {
    stubApi({ status: 400, body: { error: "body the comment is too short", code: "body_too_short", fields: { body: "the comment is too short" } } })
    const response = await submit()
    expect(response.status).toBe(422)
    expect(await response.text()).toContain("write at least 2 characters")
  })

  it("a rate limit is a 429 with its Retry-After", async () => {
    stubApi({ status: 429, body: { error: "too many requests, try again later" }, headers: { "Retry-After": "31" } })
    const response = await submit()
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("31")
    expect(await response.text()).toContain("too fast")
  })

  it("an API that doesn't answer keeps the text too, and logs no form field", async () => {
    stubApi(new Error("ECONNREFUSED"))
    const warn = vi.spyOn(log, "warn")
    const response = await submit()
    expect(response.status).toBe(503)
    expect(await response.text()).toContain("My &lt;b&gt;thoughts")
    expect(warn).toHaveBeenCalledWith("comment_post_failed", { status: 502 })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("maya@example.com")
    expect(JSON.stringify(warn.mock.calls)).not.toContain("thoughts")
  })
})

describe("POST /gl-comments/posts/:id with scripts", () => {
  it("answers the API's JSON and status", async () => {
    stubApi({ status: 201, body: { outcome: "published", comment_id: 7, post_url: "/post/hello", comment_url: "/post/hello#comment-7" } })
    const response = await submit({ headers: { Accept: "application/json" } })
    expect(response.status).toBe(201)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(await response.json()).toEqual({ outcome: "published", comment_id: 7, post_url: "/post/hello", comment_url: "/post/hello#comment-7" })
  })

  it("passes a refusal on as JSON", async () => {
    stubApi({ status: 409, body: { error: "closed", code: "comments_closed" } })
    const response = await submit({ headers: { Accept: "application/json" } })
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe("comments_closed")
  })
})

describe("what the endpoint refuses itself", () => {
  it("a post from another site, without calling the API", async () => {
    stubApi({ status: 202, body: {} })
    expect((await submit({ headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403)
    expect((await submit({ headers: { "Sec-Fetch-Site": "", Origin: "https://evil.example" } })).status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it("a same-origin post from a browser without Sec-Fetch-Site goes through", async () => {
    stubApi({ status: 202, body: { outcome: "confirm_email", post_url: "/post/hello" } })
    expect((await submit({ headers: { "Sec-Fetch-Site": "", Origin: SITE } })).status).toBe(303)
  })

  it("a GET, and a post id that isn't one", async () => {
    stubApi({ status: 202, body: {} })
    const get = await submit({ method: "GET" })
    expect(get.status).toBe(405)
    expect(get.headers.get("cache-control")).toBe("private, no-store")
    expect((await submit({ id: "abc" })).status).toBe(404)
    expect(calls).toHaveLength(0)
  })
})
