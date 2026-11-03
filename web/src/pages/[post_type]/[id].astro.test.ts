// The post route reads the published post (#358): its title, excerpt, featured image
// and terms come from GET /public/posts/:id, never from the working copy an editor is
// changing (/api/v1/posts/:id, which the admin uses).
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import { getContainerRenderer as reactRenderer } from "@astrojs/react"
import { loadRenderers } from "astro:container"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/siteSettings", () => ({
  getSiteSettings: async () => ({ title: "Field Notes", postsPerPage: 10, urlStructure: "id" }),
}))
vi.mock("@/lib/menus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/menus")>()),
  getMenu: async () => null,
}))

const PostRoute = (await import("./[id].astro")).default
const { SERVER_API_URL, SERVER_MEDIA_URL } = await import("@gl-admin/lib/server-api-url")

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const doc = {
  doc_version: 1,
  blocks_order: ["b1"],
  blocks: { b1: { id: "b1", type: "paragraph", version: 1, attrs: { text: "Published body" }, content: [{ type: "text", text: "Published body" }] } },
}
const publishedView = {
  post: {
    id: 7,
    title: "Published title",
    description: "Published excerpt for the meta description",
    slug: "the-post",
    post_type: "post",
    post_status: "published",
    user_id: 1,
    username: "ana",
    created_at: "2026-10-01T10:00:00Z",
    changed_at: "2026-10-02T10:00:00Z",
    published_blocks: doc,
  },
  featured_image: { id: 5, url: "/uploads/media/published.jpg" },
  taxonomy_terms: [{ id: 3, name: "Guides", slug: "guides", taxonomy_type_name: "category" }],
}

function stubApi(publicPost: Response | (() => Response)) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === `${SERVER_MEDIA_URL}/public/posts/7`) return typeof publicPost === "function" ? publicPost() : publicPost
    if (url === `${SERVER_API_URL}/post-types`) return json(200, { post_types: [{ name: "post", public: true, is_active: true }, { name: "page", public: true, is_active: true }] })
    if (url === `${SERVER_API_URL}/taxonomy/types`) return json(200, { taxonomy_types: [{ name: "category", label: "Categories", public: true }] })
    if (url === `${SERVER_API_URL}/themes/active`) return json(200, { slug: "default", settings: {} })
    if (url.startsWith(`${SERVER_MEDIA_URL}/public/posts/7/authors`)) return json(200, { authors: [] })
    if (url.startsWith(`${SERVER_MEDIA_URL}/public/posts/7/adjacent`)) return json(200, { previous: null, next: null })
    if (url.startsWith(`${SERVER_MEDIA_URL}/public/posts/7/related`)) return json(200, { posts: [] })
    // The working copy: the route must never read it.
    if (url.startsWith(`${SERVER_API_URL}/posts/7`)) {
      return json(200, { post: { ...publishedView.post, title: "Working title" }, featured_image: { url: "/uploads/media/working.jpg" } })
    }
    return json(404, { error: "not found" })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

let container: AstroContainer
beforeEach(async () => {
  container = await AstroContainer.create({ renderers: await loadRenderers([reactRenderer()]) })
})
afterEach(() => vi.unstubAllGlobals())

const render = () =>
  container.renderToResponse(PostRoute, {
    params: { post_type: "post", id: "7" },
    request: new Request("http://web:4321/post/7"),
  })

describe("[post_type]/[id] route", () => {
  it("renders the published title, excerpt, featured image and terms", async () => {
    const fetchMock = stubApi(json(200, publishedView))
    const response = await render()
    expect(response.status).toBe(200)
    const html = (await response.text()).replace(/\s+data-astro-source-(?:file|loc)="[^"]*"/g, "")
    expect(html).toContain("Published title")
    expect(html).toContain("Published excerpt for the meta description")
    expect(html).toContain("/uploads/media/published.jpg")
    expect(html).toContain("Guides")
    expect(html).not.toContain("Working title")
    expect(html).not.toContain("working.jpg")
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls).toContain(`${SERVER_MEDIA_URL}/public/posts/7`)
    expect(urls.some((url) => url.startsWith(`${SERVER_API_URL}/posts/7`))).toBe(false)
  })

  it("404s what the public endpoint doesn't serve (a draft, an unpublished post)", async () => {
    stubApi(json(404, { error: "post not found" }))
    const response = await render()
    expect(response.status).toBe(404)
  })
})
