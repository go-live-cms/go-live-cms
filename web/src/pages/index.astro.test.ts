// The home page (#336): with a front page chosen, / renders that page (its published
// template, canonical /) from GET /public/front-page; when the API says there is none
// (404: none chosen, or it was unpublished, trashed or deleted), / is the latest posts.
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import { getContainerRenderer as reactRenderer } from "@astrojs/react"
import { loadRenderers } from "astro:container"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const site = vi.hoisted(() => ({ frontPageId: null as number | null }))
vi.mock("@/lib/siteSettings", () => ({
  getSiteSettings: async () => ({ title: "Field Notes", tagline: "Notes", postsPerPage: 10, urlStructure: "id", frontPageId: site.frontPageId }),
}))
vi.mock("@/lib/menus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/menus")>()),
  getMenu: async () => null,
}))

const HomeRoute = (await import("./index.astro")).default
const { SERVER_API_URL, SERVER_MEDIA_URL } = await import("@gl-admin/lib/server-api-url")

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const doc = {
  doc_version: 1,
  blocks_order: ["b1"],
  blocks: { b1: { id: "b1", type: "paragraph", version: 1, attrs: { text: "Welcome body" }, content: [{ type: "text", text: "Welcome body" }] } },
}
const frontView = (template: string) => ({
  post: {
    id: 12,
    title: "Welcome home",
    description: "The front page's excerpt",
    slug: "home",
    post_type: "page",
    post_status: "published",
    user_id: 1,
    username: "ana",
    created_at: "2026-10-01T10:00:00Z",
    changed_at: "2026-10-02T10:00:00Z",
    published_blocks: doc,
    page_template: template,
  },
  featured_image: null,
  taxonomy_terms: [],
  seo: { title: "", description: "", noindex: false, canonical_url: "", image: null },
})

function stubApi(front: Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === `${SERVER_MEDIA_URL}/public/front-page`) return front.clone()
    if (url.startsWith(`${SERVER_MEDIA_URL}/public/posts/type/post`)) {
      return json(200, {
        posts: [{ id: 3, title: "Latest post title", description: "", post_type: "post", post_status: "published", created_at: "2026-10-01T10:00:00Z", changed_at: "2026-10-01T10:00:00Z" }],
        pagination: { page: 1, per_page: 10, total: 1, total_pages: 1 },
      })
    }
    if (url === `${SERVER_API_URL}/taxonomy/types`) return json(200, { taxonomy_types: [] })
    if (url === `${SERVER_API_URL}/themes/active`) return json(200, { slug: "default", settings: {} })
    if (url.startsWith(`${SERVER_MEDIA_URL}/public/posts/12/authors`)) return json(200, { authors: [] })
    // The working copy: the home page must never read it.
    if (url.startsWith(`${SERVER_API_URL}/posts`)) return json(200, { post: { ...frontView("").post, title: "Working title" } })
    return json(404, { error: "not found" })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

let container: AstroContainer
beforeEach(async () => {
  container = await AstroContainer.create({ renderers: await loadRenderers([reactRenderer()]) })
  site.frontPageId = null
})
afterEach(() => vi.unstubAllGlobals())

const render = (url = "http://web:4321/", locals: Partial<App.Locals> = {}) =>
  container.renderToResponse(HomeRoute, { request: new Request(url), locals: { activeTheme: "default", ...locals } as App.Locals })

const head = (html: string) => html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? ""

describe("/ (#336)", () => {
  it("renders the front page with its published template, at /", async () => {
    site.frontPageId = 12
    const fetchMock = stubApi(json(200, frontView("fullwidth")))
    const response = await render()
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain("Welcome home")
    expect(html).toContain("Welcome body")
    // The default theme's layouts/page/fullwidth.astro, not its default page layout.
    expect(html).toContain("page--full")
    expect(html).not.toContain("page--default")
    expect(html).not.toContain("Latest post title")
    expect(html).not.toContain("Working title")
    expect(head(html)).toContain('<link rel="canonical" href="http://web:4321/">')
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.some((url) => url.startsWith(`${SERVER_MEDIA_URL}/public/posts/type/`))).toBe(false)
  })

  it("renders the default page layout without a template, and for one the theme doesn't have", async () => {
    for (const template of ["", "landing"]) {
      stubApi(json(200, frontView(template)))
      const html = await (await render()).text()
      expect(html).toContain("page--default")
      expect(html).toContain("Welcome home")
    }
  })

  it("is the latest posts when there's no front page (none, or unpublished, trashed, deleted)", async () => {
    stubApi(json(404, { error: "no front page", code: "no_front_page" }))
    const response = await render()
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain("home-header")
    expect(html).toContain("Latest post title")
    expect(html).not.toContain("Welcome home")
  })

  it("has no list pages under a front page", async () => {
    stubApi(json(200, frontView("")))
    const response = await render("http://web:4321/page/2/", { listPageNumber: 2 })
    expect(response.status).toBe(404)
  })

  it("never turns an API error into the post list", async () => {
    stubApi(json(503, { error: "unavailable" }))
    await expect(render()).rejects.toThrow(/front page/)
  })
})
