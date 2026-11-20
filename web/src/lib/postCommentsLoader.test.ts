// The post route's comments read (#525, design 11.1): only when there is something to show,
// the page or thread the URL names, and never a failed page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadPostComments } from "./postCommentsLoader"
import { log } from "./log"

const NOW = new Date("2026-11-20T12:00:00Z")
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const open = { state: "open" as const, closes_at: null, count: 3 }
const answer = (page: number) => ({ discussion: open, threads: [{ comment: { id: page }, replies: [], reply_count: 0 }], pagination: { page, per_page: 30, total: 31, total_pages: 2 } })

let calls: string[]
function stub(reply: (url: string) => Response | Promise<Response>) {
  calls = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url))
      return reply(String(url))
    }),
  )
}
const url = (query = "") => new URL(`http://site.example/post/hello${query}`)

beforeEach(() => stub(() => json(200, answer(1))))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("loadPostComments", () => {
  it("reads nothing when comments are off, absent, or closed with none", async () => {
    expect(await loadPostComments(7, { state: "off", closes_at: null, count: 0 }, url(), NOW)).toBeNull()
    expect(await loadPostComments(7, null, url(), NOW)).toBeNull()
    expect(await loadPostComments(7, { state: "closed", closes_at: null, count: 0 }, url(), NOW)).toBeNull()
    // Open by its setting, but past closes_at: closed, and none.
    expect(await loadPostComments(7, { state: "open", closes_at: "2026-11-01T00:00:00Z", count: 0 }, url(), NOW)).toBeNull()
    expect(calls).toEqual([])
  })

  it("open with none: the empty thread, without a read", async () => {
    expect(await loadPostComments(7, { ...open, count: 0 }, url(), NOW)).toEqual({ discussion: { ...open, count: 0 }, threads: [], pagination: null })
    expect(calls).toEqual([])
  })

  it("reads page 1, or the page ?comments= names", async () => {
    expect((await loadPostComments(7, open, url(), NOW))?.pagination?.page).toBe(1)
    expect(calls[0]).toMatch(/\/public\/posts\/7\/comments$/)
    stub(() => json(200, answer(2)))
    expect((await loadPostComments(7, open, url("?comments=2"), NOW))?.pagination?.page).toBe(2)
    expect(calls[0]).toMatch(/\/public\/posts\/7\/comments\?page=2$/)
  })

  it("a page past the end falls back to page 1", async () => {
    stub((u) => (u.includes("page=9") ? json(404, { error: "no such page" }) : json(200, answer(1))))
    expect((await loadPostComments(7, open, url("?comments=9"), NOW))?.pagination?.page).toBe(1)
    expect(calls).toHaveLength(2)
  })

  it("?thread= reads that thread alone, else page 1", async () => {
    stub((u) => (u.includes("thread=5") ? json(200, { discussion: open, thread: { comment: { id: 5 }, replies: [], reply_count: 0 } }) : json(404, {})))
    expect(await loadPostComments(7, open, url("?thread=5"), NOW)).toMatchObject({ thread: 5, pagination: null, threads: [{ comment: { id: 5 } }] })
    stub((u) => (u.includes("thread=") ? json(404, {}) : json(200, answer(1))))
    expect(await loadPostComments(7, open, url("?thread=6"), NOW)).toMatchObject({ threads: [{ comment: { id: 1 } }] })
  })

  it("a failed read renders the post without the section: null, logged", async () => {
    const warn = vi.spyOn(log, "warn")
    stub(() => json(500, { error: "boom" }))
    expect(await loadPostComments(7, open, url(), NOW)).toBeNull()
    expect(warn).toHaveBeenCalledWith("comments_fetch_failed", expect.objectContaining({ post_id: 7 }))
    stub(() => Promise.reject(new TypeError("fetch failed")))
    expect(await loadPostComments(7, open, url(), NOW)).toBeNull()
  })
})
