// The term archive route (#348): reached only through the /{taxonomy}/{slug} hand-over
// (Astro.locals.termArchive), it 404s an unknown term and renders the default theme's
// term layout otherwise.
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/siteSettings", () => ({
  getSiteSettings: async () => ({ title: "Field Notes", postsPerPage: 10, urlStructure: "slug" }),
}))
vi.mock("@/lib/menus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/menus")>()),
  getMenu: async () => null,
}))

const TermArchive = (await import("./term.archive.astro")).default
const { SERVER_MEDIA_URL } = await import("@gl-admin/lib/server-api-url")

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const term = { id: 7, name: "Guides", slug: "guides", description: "How-tos.", taxonomy: "category", taxonomy_label: "Categories", hierarchical: true }
const row = { id: 3, title: "First guide", slug: "first-guide", post_type: "post", post_status: "published", created_at: "2026-10-01T10:00:00Z", meta: {}, authors: [] }

let container: AstroContainer
beforeEach(async () => {
  container = await AstroContainer.create()
})
afterEach(() => vi.unstubAllGlobals())

const render = (locals: Record<string, unknown>) =>
  container.renderToResponse(TermArchive, { locals, request: new Request("http://web:4321/term.archive") })

describe("term.archive route", () => {
  it("404s when reached directly, without a term handed over", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const response = await render({})
    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("404s an unknown or non-public term (the API's 404)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { error: "term not found" })))
    const response = await render({ termArchive: { taxonomy: "category", slug: "nothing" } })
    expect(response.status).toBe(404)
  })

  it("renders the term's page N with its title, canonical and posts", async () => {
    const fetchMock = vi.fn(async () => json(200, { term, posts: [row], pagination: { page: 2, per_page: 10, total: 11, total_pages: 2 } }))
    vi.stubGlobal("fetch", fetchMock)
    const response = await render({ termArchive: { taxonomy: "category", slug: "guides" }, listPageNumber: 2 })
    expect(response.status).toBe(200)
    // Dev builds tag elements with data-astro-source-* (the dev toolbar); compare without them.
    const html = (await response.text()).replace(/\s+data-astro-source-(?:file|loc)="[^"]*"/g, "")
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(`${SERVER_MEDIA_URL}/public/taxonomies/category/terms/guides/posts?page=2`)
    expect(html).toContain("<title>Guides · Page 2 | Field Notes</title>")
    expect(html).toMatch(/<link rel="canonical" href="[^"]*\/category\/guides\/page\/2\/"/)
    expect(html).toMatch(/<link rel="prev" href="[^"]*\/category\/guides"/)
    expect(html).toContain('<h1 class="title">Guides</h1>')
    expect(html).toContain('<a href="/post/first-guide">First guide</a>')
  })
})
