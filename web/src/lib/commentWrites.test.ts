import { describe, expect, it, vi } from "vitest"

import {
  apiWriteHeaders,
  COMMENT_BODY_MAX_BYTES,
  COMMENT_FORM_FIELDS,
  COMMENTER_COOKIE,
  COMMENTER_KEY_HEADER,
  commenterKeys,
  commenterSetCookie,
  commentRefusal,
  commentRequestBody,
  errorCodeParam,
  jsonAnswer,
  postToApi,
  readFields,
  safeReturnPath,
  withCommenterKey,
  withCommentedNotice,
} from "./commentWrites"
import { hasSessionCookie, isPerReaderUrl } from "./httpCache"

// The comment endpoints' rules (#524, docs/design/reader-comments.md 9.4).

const key = (c: string) => c.repeat(43)

describe("the browser key cookie", () => {
  it("is path-scoped to the endpoints, HttpOnly, Lax, a year, Secure outside plain-HTTP dev", () => {
    expect(commenterSetCookie([key("a")], true)).toBe(
      `${COMMENTER_COOKIE}=${key("a")}; Path=/gl-comments; HttpOnly; SameSite=Lax; Secure; Max-Age=31536000`,
    )
    expect(commenterSetCookie([key("a"), key("b")], false)).toBe(
      `${COMMENTER_COOKIE}=${key("a")}.${key("b")}; Path=/gl-comments; HttpOnly; SameSite=Lax; Max-Age=31536000`,
    )
  })

  it("never reaches a page: its path is the endpoints', and it isn't a session cookie", () => {
    const cookie = commenterSetCookie([key("a")], true)
    const path = /Path=([^;]+)/.exec(cookie)![1]
    for (const page of ["/", "/post/hello", "/comments/confirm", "/gl-admin"]) {
      expect(page === path || page.startsWith(`${path}/`)).toBe(false)
    }
    // A page request never carries it, so it can't make a page private: it isn't one of
    // the cookies httpCache.ts counts, and needn't be.
    expect(hasSessionCookie(`${COMMENTER_COOKIE}=${key("a")}`)).toBe(false)
  })

  it("reads well-formed keys only, at most five, the newest last", () => {
    const keys = [key("a"), "short", key("b"), key("c"), key("d"), key("e"), key("f")]
    expect(commenterKeys(`theme=dark; ${COMMENTER_COOKIE}=${keys.join(".")}; x=1`)).toEqual([key("b"), key("c"), key("d"), key("e"), key("f")])
    expect(commenterKeys(null)).toEqual([])
    expect(commenterKeys(`${COMMENTER_COOKIE}=`)).toEqual([])
    expect(commenterKeys(`other=${key("a")}`)).toEqual([])
  })

  it("adds a confirmation's key last, once, keeping five", () => {
    expect(withCommenterKey([key("a"), key("b")], key("a"))).toEqual([key("b"), key("a")])
    expect(withCommenterKey([key("a"), key("b"), key("c"), key("d"), key("e")], key("f"))).toEqual([key("b"), key("c"), key("d"), key("e"), key("f")])
  })
})

describe("the form's mapping", () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData()
    for (const [name, value] of Object.entries(fields)) f.set(name, value)
    return f
  }

  it("maps the fields to the API's JSON", () => {
    expect(
      commentRequestBody(
        form({
          [COMMENT_FORM_FIELDS.body]: "Nice post",
          [COMMENT_FORM_FIELDS.name]: "Maya",
          [COMMENT_FORM_FIELDS.email]: " maya@example.com ",
          [COMMENT_FORM_FIELDS.notifyReplies]: "1",
          [COMMENT_FORM_FIELDS.website]: "",
          [COMMENT_FORM_FIELDS.parentId]: "17",
        }),
      ),
    ).toEqual({ name: "Maya", email: "maya@example.com", body: "Nice post", notify_replies: true, website: "", parent_id: 17 })
  })

  it("leaves out a parent that isn't an id, and an unticked box is false", () => {
    for (const parent of ["", "0", "-3", "1e3", "abc", "12.5"]) {
      expect(commentRequestBody(form({ [COMMENT_FORM_FIELDS.parentId]: parent }))).not.toHaveProperty("parent_id")
    }
    expect(commentRequestBody(form({})).notify_replies).toBe(false)
  })

  it("passes the honeypot on as it is", () => {
    expect(commentRequestBody(form({ [COMMENT_FORM_FIELDS.website]: "https://spam.example" })).website).toBe("https://spam.example")
  })

  it("reads a form or a JSON object", async () => {
    const json = await readFields(new Request("http://x/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "t", n: 1, nested: { a: 1 } }) }))
    expect(json?.get("token")).toBe("t")
    expect(json?.get("n")).toBe("1")
    expect(json?.get("nested")).toBeNull()
    const posted = await readFields(new Request("http://x/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "token=u" }))
    expect(posted?.get("token")).toBe("u")
    expect(await readFields(new Request("http://x/", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[1]" }))).toBeNull()
  })

  it("reads no multipart form and nothing past its limit", async () => {
    const multipart = new FormData()
    multipart.set("token", "t")
    expect(await readFields(new Request("http://x/", { method: "POST", body: multipart }))).toBeNull()
    const huge = `comment=${"x".repeat(COMMENT_BODY_MAX_BYTES)}`
    expect(await readFields(new Request("http://x/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: huge }))).toBeNull()
    // A body that hides its length is cut off as it is read.
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(new TextEncoder().encode("x".repeat(COMMENT_BODY_MAX_BYTES / 2)))
        controller.close()
      },
    })
    const streamed = new Request("http://x/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: stream, duplex: "half" } as RequestInit)
    expect(await readFields(streamed)).toBeNull()
    // 4000 emoji, form-encoded, fit.
    const emoji = new URLSearchParams({ comment: "😀".repeat(4000) }).toString()
    expect((await readFields(new Request("http://x/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: emoji })))?.get("comment")).toHaveLength(8000)
  })
})

describe("where the browser goes back to", () => {
  it("is a path on this site, else the fallback", () => {
    expect(safeReturnPath("/post/hello?comments=2")).toBe("/post/hello?comments=2")
    for (const bad of ["https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)", "", null, 3, "/a\nb"]) {
      expect(safeReturnPath(bad, "/fallback")).toBe("/fallback")
    }
  })

  it("carries the outcome's notice to the form, and drops reply mode", () => {
    expect(withCommentedNotice("/post/hello", "confirm_email")).toBe("/post/hello?commented=confirm#comment-form")
    expect(withCommentedNotice("/post/hello?comments=2&replyto=7#comment-7", "pending")).toBe("/post/hello?comments=2&commented=pending#comment-form")
    expect(withCommentedNotice("/post/hello?commented=pending", "published")).toBe("/post/hello?commented=published#comment-form")
    expect(withCommentedNotice("https://evil.example/", "published")).toBe("/?commented=published#comment-form")
  })

  it("is a per-reader URL, never cached", () => {
    expect(isPerReaderUrl(new URL("https://site.example/post/hello?commented=pending"))).toBe(true)
    expect(isPerReaderUrl(new URL("https://site.example/gl-comments/posts/4"))).toBe(true)
    expect(isPerReaderUrl(new URL("https://site.example/comments/confirm"))).toBe(true)
    expect(isPerReaderUrl(new URL("https://site.example/comments/confirm/"))).toBe(true)
    expect(isPerReaderUrl(new URL("https://site.example/post/hello?comments=2"))).toBe(false)
    // A post of a type named "comments" whose slug merely starts like a reader page.
    expect(isPerReaderUrl(new URL("https://site.example/comments/confirmation-bias"))).toBe(false)
    expect(isPerReaderUrl(new URL("https://site.example/gl-commentsx"))).toBe(false)
  })
})

describe("the call to the API", () => {
  it("forwards the browser's address, the request id and the keys; never the cookie", () => {
    const request = new Request("https://site.example/gl-comments/posts/4", {
      method: "POST",
      headers: { "X-Forwarded-For": "203.0.113.7", Cookie: `${COMMENTER_COOKIE}=${key("a")}.${key("b")}; __Host-refresh_token=secret`, "User-Agent": "Test/1" },
    })
    const headers = apiWriteHeaders(request, "172.28.0.11")
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.7, 172.28.0.11")
    expect(headers.get(COMMENTER_KEY_HEADER)).toBe(`${key("a")}, ${key("b")}`)
    expect(headers.get("cookie")).toBeNull()
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("user-agent")).toBe("Test/1")
  })

  it("without a peer address keeps the incoming chain; without keys sends no key header", () => {
    const headers = apiWriteHeaders(new Request("https://site.example/", { headers: { "X-Forwarded-For": "203.0.113.7" } }), undefined)
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.7")
    expect(headers.has(COMMENTER_KEY_HEADER)).toBe(false)
  })

  it("an unreachable API is a 502 answer", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    })
    expect(await postToApi("http://api/x", {}, new Headers(), fetchImpl as unknown as typeof fetch)).toEqual({ status: 502, body: {}, retryAfter: null })
  })

  it("the JSON answer never carries the key, and is never cached", async () => {
    const response = jsonAnswer({ status: 200, body: { outcome: "published", set_key: key("a") }, retryAfter: null })
    expect(await response.json()).toEqual({ outcome: "published" })
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    const limited = jsonAnswer({ status: 429, body: { error: "slow down" }, retryAfter: "12" })
    expect(limited.headers.get("retry-after")).toBe("12")
  })
})

describe("refusals", () => {
  const answer = (status: number, body: Record<string, unknown>) => ({ status, body, retryAfter: null })

  it("say why, as the reader would", () => {
    expect(commentRefusal(answer(409, { code: "comments_closed" }))).toEqual({ status: 422, reason: "Comments on this post are closed." })
    expect(commentRefusal(answer(409, { code: "comments_off" })).reason).toBe("Comments are off for this post.")
    expect(commentRefusal(answer(404, { code: "parent_not_found" })).reason).toMatch(/replied to/)
    expect(commentRefusal(answer(400, { code: "body_too_short" })).reason).toMatch(/at least 2/)
    expect(commentRefusal(answer(400, { fields: { email: "must be a valid email" } })).reason).toBe("Check your email address.")
    expect(commentRefusal(answer(429, { code: "comments_busy" }))).toEqual({ status: 429, reason: expect.stringMatching(/waiting for review/) })
    expect(commentRefusal(answer(429, { error: "too many requests" })).reason).toMatch(/too fast/)
    expect(commentRefusal(answer(502, {})).status).toBe(503)
    expect(commentRefusal(answer(400, {})).reason).toBe("Your comment couldn't be posted.")
  })

  it("put only a code in a URL", () => {
    expect(errorCodeParam(answer(400, { code: "invalid_token" }))).toBe("invalid_token")
    expect(errorCodeParam(answer(400, { code: "<script>" }))).toBe("failed")
    expect(errorCodeParam(answer(500, {}))).toBe("failed")
  })
})
