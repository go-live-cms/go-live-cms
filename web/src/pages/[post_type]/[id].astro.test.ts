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

  // #356: "Copy link to block" copies /<post url>#b-<block id>; the page must have that id,
  // once, on the block, for every top-level block (the heading keeps its #351 slug).
  it("gives every top-level block its b-<id> anchor, once on the page", async () => {
    const ids = {
      heading: "6f1c2a90-8a51-4f7e-9b1e-0d3c2b1a0f01",
      paragraph: "6f1c2a90-8a51-4f7e-9b1e-0d3c2b1a0f02",
      list: "6f1c2a90-8a51-4f7e-9b1e-0d3c2b1a0f03",
      item: "6f1c2a90-8a51-4f7e-9b1e-0d3c2b1a0f04",
      quote: "6f1c2a90-8a51-4f7e-9b1e-0d3c2b1a0f05",
    }
    const pm = (type: string, text: string, attrs: object = {}) => ({ type, attrs, content: [{ type: "text", text }] })
    const anchored = {
      doc_version: 1,
      blocks_order: [ids.heading, ids.paragraph, ids.list, ids.quote],
      blocks: {
        [ids.heading]: { id: ids.heading, type: "heading", version: 1, attrs: { level: 2, pm: pm("heading", "How it works", { level: 2 }), text: "How it works" } },
        [ids.paragraph]: { id: ids.paragraph, type: "paragraph", version: 1, attrs: { pm: pm("paragraph", "Body"), text: "Body", blockColor: "blue-background" } },
        [ids.list]: { id: ids.list, type: "bullet_list", version: 1, attrs: {}, children: [ids.item] },
        [ids.item]: { id: ids.item, type: "list_item", version: 1, attrs: { pm: { type: "listItem", content: [pm("paragraph", "Item")] }, text: "Item" } },
        [ids.quote]: {
          id: ids.quote,
          type: "blockquote",
          version: 2,
          attrs: { pm: { type: "blockquote", content: [pm("paragraph", "Quoted")] }, text: "Quoted" },
        },
      },
    }
    stubApi(json(200, { ...publishedView, post: { ...publishedView.post, published_blocks: anchored } }))
    const response = await render()
    expect(response.status).toBe(200)
    const html = await response.text()
    const count = (id: string) => html.split(`id="${id}"`).length - 1
    for (const id of [ids.heading, ids.paragraph, ids.list, ids.quote]) expect(count(`b-${id}`), id).toBe(1)
    // List items aren't top-level blocks.
    expect(count(`b-${ids.item}`)).toBe(0)
    expect(count("how-it-works")).toBe(1)
    expect(html).toContain(`<p id="b-${ids.paragraph}" class="gl-color-blue-background">`)
  })

  // #357: the published SEO, never the working one (the admin's GET /posts/:id).
  it("builds the head from the published SEO", async () => {
    process.env.SITE_URL = "https://example.org"
    try {
      stubApi(
        json(200, {
          ...publishedView,
          seo: {
            title: "Published SEO title",
            description: "Published SEO description",
            noindex: true,
            canonical_url: "https://elsewhere.example/original",
            image: { url: "/uploads/media/_variants/share.png/social.png", width: 1200, height: 630, alt: "Two documents" },
          },
        }),
      )
      const response = await render()
      expect(response.status).toBe(200)
      const html = await response.text()
      const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? ""
      expect(head).toContain("<title>Published SEO title · Field Notes</title>")
      expect(head).toContain('<meta name="description" content="Published SEO description">')
      expect(head).toContain('<link rel="canonical" href="https://elsewhere.example/original">')
      expect(head).toContain('<meta name="robots" content="noindex">')
      expect(head).toContain('<meta property="og:image" content="https://example.org/uploads/media/_variants/share.png/social.png">')
      expect(head).toContain('<meta property="og:image:width" content="1200">')
      expect(head).toContain('<meta name="twitter:card" content="summary_large_image">')
      const ld = head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1]
      expect(JSON.parse(ld ?? "{}")).toMatchObject({ "@type": "Article", headline: "Published SEO title", author: [{ name: "ana" }] })
      // The page's own heading stays the post title.
      expect(html).toMatch(/<h1[^>]*>\s*Published title\s*<\/h1>/)
    } finally {
      delete process.env.SITE_URL
    }
  })

  it("without SEO fields: the post title, and the first paragraph when there's no excerpt", async () => {
    stubApi(
      json(200, {
        ...publishedView,
        post: { ...publishedView.post, description: "" },
        seo: { title: "", description: "", noindex: false, canonical_url: "", image: null },
      }),
    )
    const response = await render()
    const head = (await response.text()).match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? ""
    expect(head).toContain("<title>Published title · Field Notes</title>")
    expect(head).toContain('<meta name="description" content="Published body">')
    expect(head).toContain('<link rel="canonical" href="http://web:4321/post/7">')
    expect(head).not.toContain('name="robots"')
    // No social image from the API, so the published featured image.
    expect(head).toContain('<meta property="og:image" content="http://web:4321/uploads/media/published.jpg">')
  })

  it("404s what the public endpoint doesn't serve (a draft, an unpublished post)", async () => {
    stubApi(json(404, { error: "post not found" }))
    const response = await render()
    expect(response.status).toBe(404)
  })
})
