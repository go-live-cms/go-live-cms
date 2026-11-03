// @vitest-environment node
// RSS and the sitemap read the public posts list (#358): published titles and excerpts,
// never the working ones an editor is changing (those come from /api/v1/posts, which
// the admin uses).
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../lib/siteSettings", () => ({
  getSiteSettings: async () => ({ title: "Field Notes", urlStructure: "slug" }),
}))

const { GET: rss } = await import("./rss.xml")
const { GET: sitemap } = await import("./sitemap.xml")
const { SERVER_API_URL, SERVER_MEDIA_URL } = await import("@gl-admin/lib/server-api-url")

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// The public list answers with the published title and excerpt; /api/v1/posts would
// have the working ones.
const published = {
  id: 7,
  title: "Published title",
  description: "Published excerpt",
  slug: "the-post",
  post_type: "post",
  post_status: "published",
  created_at: "2026-10-01T10:00:00Z",
  changed_at: "2026-10-02T10:00:00Z",
}
const working = { ...published, title: "Working title", description: "Working excerpt" }

function stubApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith(`${SERVER_MEDIA_URL}/public/posts?`)) return json({ posts: [published], meta: { total: 1 } })
    if (url.startsWith(`${SERVER_API_URL}/posts`)) return json({ posts: [working], meta: { total: 1 } })
    if (url === `${SERVER_API_URL}/post-types`) return json({ post_types: [{ name: "post", public: true, is_active: true }] })
    if (url === `${SERVER_API_URL}/settings`) return json({ post_url_structure: "slug" })
    if (url.startsWith(`${SERVER_MEDIA_URL}/public/terms`)) return json({ terms: [] })
    if (url.startsWith(`${SERVER_MEDIA_URL}/public/authors`)) return json({ authors: [] })
    return json({ error: "not found" }, 404)
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const calledUrls = (fetchMock: ReturnType<typeof stubApi>) => fetchMock.mock.calls.map((call) => String(call[0]))

afterEach(() => vi.unstubAllGlobals())

describe("rss.xml", () => {
  it("lists the published titles and excerpts", async () => {
    const fetchMock = stubApi()
    const response = await rss({ url: new URL("http://web:4321/rss.xml") } as never)
    expect(response.status).toBe(200)
    const xml = await response.text()
    expect(xml).toContain("<title>Published title</title>")
    expect(xml).toContain("Published excerpt")
    expect(xml).not.toContain("Working title")
    expect(calledUrls(fetchMock)).toContain(`${SERVER_MEDIA_URL}/public/posts?type=post&limit=20&sort=date_desc`)
    expect(calledUrls(fetchMock).some((url) => url.startsWith(`${SERVER_API_URL}/posts`))).toBe(false)
  })

  it("is an empty feed when the post type isn't public (the API's 404)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "post type not found" }, 404)))
    const response = await rss({ url: new URL("http://web:4321/rss.xml") } as never)
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain("<item>")
  })

  it("answers 503 when the list fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "down" }, 500)))
    const response = await rss({ url: new URL("http://web:4321/rss.xml") } as never)
    expect(response.status).toBe(503)
  })
})

describe("sitemap.xml", () => {
  it("lists published posts from the public list", async () => {
    const fetchMock = stubApi()
    const response = await sitemap({ url: new URL("http://web:4321/sitemap.xml") } as never)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("/post/the-post</loc>")
    expect(calledUrls(fetchMock)).toContain(`${SERVER_MEDIA_URL}/public/posts?type=post&limit=100&sort=id&order=asc`)
    expect(calledUrls(fetchMock).some((url) => url.startsWith(`${SERVER_API_URL}/posts`))).toBe(false)
  })
})
