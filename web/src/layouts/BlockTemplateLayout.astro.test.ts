// The site design's one branch (#491, docs/design/theme-builder.md 3.2 to 3.4), through the
// real route files with the Container API: for every route kind a published builder template
// renders through BlockTemplateLayout and a reset one (the resolve answers no template) falls
// back to the theme's code layout; a failed resolve renders the code layout; the 500 page never
// resolves; a template customized on the default theme renders core's starter header and footer
// until the parts are; a code layout's <TemplatePart> renders a published override part; and
// SeoHead's output is the code layout's for the same post.
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import { getContainerRenderer as reactRenderer } from "@astrojs/react"
import { loadRenderers } from "astro:container"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const site = vi.hoisted(() => ({ frontPageId: null as number | null }))
vi.mock("@/lib/siteSettings", () => ({
  getSiteSettings: async () => ({
    title: "Field Notes",
    tagline: "Notes from the field",
    language: "en",
    timeZone: "UTC",
    dateFormat: "long",
    postsPerPage: 10,
    urlStructure: "id",
    frontPageId: site.frontPageId,
    logo: null,
  }),
}))
vi.mock("@/lib/menus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/menus")>()),
  getMenu: async () => null,
}))

const { log } = await import("@/lib/log")
const { SERVER_API_URL, SERVER_MEDIA_URL } = await import("@gl-admin/lib/server-api-url")
const HomeRoute = (await import("../pages/index.astro")).default
const ArchiveRoute = (await import("../pages/[post_type]/index.astro")).default
const PostRoute = (await import("../pages/[post_type]/[id].astro")).default
const TermRoute = (await import("../pages/term.archive.astro")).default
const AuthorRoute = (await import("../pages/author/[username].astro")).default
const SearchRoute = (await import("../pages/search/index.astro")).default
const NotFoundRoute = (await import("../pages/404.astro")).default
const ServerErrorRoute = (await import("../pages/500.astro")).default

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

type B = { id: string; type: string; version: number; attrs: Record<string, unknown>; children?: string[] }
const b = (id: string, type: string, attrs: Record<string, unknown> = {}, children?: string[]): B => ({ id, type, version: 1, attrs, ...(children ? { children } : {}) })
const docOf = (order: string[], ...blocks: B[]) => ({ doc_version: 1, blocks_order: order, blocks: Object.fromEntries(blocks.map((x) => [x.id, x])) })
const para = (id: string, text: string) => b(id, "paragraph", { text, pm: { type: "paragraph", content: [{ type: "text", text }] } })

const postBody = docOf(["body-00001"], para("body-00001", "The body of the post"))
const post = (id: number, title: string, type = "post", extra: Record<string, unknown> = {}) => ({
  id,
  title,
  description: `About ${title}`,
  slug: title.toLowerCase().replace(/\s+/g, "-"),
  post_type: type,
  post_status: "published",
  user_id: 1,
  username: "ana",
  created_at: "2026-10-01T10:00:00Z",
  changed_at: "2026-10-02T10:00:00Z",
  published_blocks: postBody,
  ...extra,
})

// A template: the starter header, a marker, what the route kind shows, the starter footer.
function templateDoc(kind: string) {
  const middle: B[] =
    kind === "single" || kind === "page" || kind === "front-page"
      ? [b("tpl-title", "post_title"), b("tpl-content", "post_content")]
      : kind === "404"
        ? []
        : [
            b("tpl-qtitle", "query_title"),
            b("tpl-query", "query", { inherit: true }, ["tpl-items", "tpl-empty"]),
            b("tpl-items", "post_template", {}, ["tpl-item-title"]),
            b("tpl-item-title", "post_title"),
            b("tpl-empty", "query_no_results", {}, ["tpl-empty-text"]),
            para("tpl-empty-text", "Nothing in this list"),
          ]
  const top = middle.filter((block) => !["tpl-items", "tpl-item-title", "tpl-empty", "tpl-empty-text"].includes(block.id)).map((block) => block.id)
  return docOf(
    ["tpl-header", "tpl-marker", ...top, "tpl-footer"],
    b("tpl-header", "template_part", { slug: "header" }),
    para("tpl-marker", `BUILDER-${kind.toUpperCase()}`),
    ...middle,
    b("tpl-footer", "template_part", { slug: "footer" }),
  )
}
const starterHeader = docOf(["h-title"], b("h-title", "site_title"))
const starterFooter = docOf(["f-tagline"], b("f-tagline", "site_tagline"))

const api = vi.hoisted(() => ({ mode: "override" as "override" | "reset" | "fail", overrideParts: {} as Record<string, unknown>, slugs: [] as string[] }))

function resolveBody(slugs: string[]) {
  const parts: Record<string, unknown> = { ...api.overrideParts }
  if (api.mode === "reset") return { theme: "default", template: null, parts, menus: {} }
  // The kind's own slug is customized (author), else its least specific (single, page,
  // archive, home, search, 404): where the default theme has a code layout of the same rank.
  const slug = slugs.includes("author") ? "author" : slugs[slugs.length - 1]
  const kind = slug
  const rendered = slugs[0] === "front-page" && site.frontPageId ? "front-page" : kind
  parts.header ??= { source: "starter", title: "Header", doc: starterHeader }
  parts.footer ??= { source: "starter", title: "Footer", doc: starterFooter }
  return { theme: "default", template: { slug, rank: slugs.indexOf(slug), source: "override", title: slug, doc: templateDoc(rendered) }, parts, menus: {} }
}

function stubApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const path = url.pathname
    if (path.endsWith("/public/site-templates/resolve")) {
      api.slugs = (url.searchParams.get("slugs") ?? "").split(",")
      if (api.mode === "fail") return json(502, { error: "bad gateway" })
      return json(200, resolveBody(api.slugs))
    }
    if (String(input) === `${SERVER_MEDIA_URL}/public/front-page`) return site.frontPageId ? json(200, { post: post(12, "Welcome home", "page", { page_template: "" }), taxonomy_terms: [] }) : json(404, {})
    if (path === "/public/posts/7") return json(200, { post: post(7, "Published post"), featured_image: null, taxonomy_terms: [] })
    if (path === "/public/posts/8") return json(200, { post: post(8, "About us", "page"), featured_image: null, taxonomy_terms: [] })
    if (/^\/public\/posts\/\d+\/(authors)$/.test(path)) return json(200, { authors: [] })
    if (/^\/public\/posts\/\d+\/adjacent$/.test(path)) return json(200, { previous: null, next: null })
    if (/^\/public\/posts\/\d+\/related$/.test(path)) return json(200, { posts: [] })
    if (path.startsWith("/public/posts/type/post")) return json(200, { posts: [post(3, "Listed post")], pagination: { page: 1, per_page: 10, total: 1, total_pages: 1 } })
    if (path === "/public/taxonomies/category/terms/guides/posts")
      return json(200, { term: { id: 4, name: "Guides", slug: "guides", description: "", taxonomy: "category", taxonomy_label: "Categories", hierarchical: true }, posts: [post(3, "Listed post")], pagination: { page: 1, per_page: 10, total: 1, total_pages: 1 } })
    if (path === "/public/authors/ana/posts") return json(200, { author: { username: "ana", full_name: "Ana Costa", bio: "", website: "" }, posts: [post(3, "Listed post")], meta: { total: 1 } })
    if (path === "/public/search")
      return json(200, {
        query: "notes",
        type: "all",
        results: [{ id: 3, title: "Listed post", slug: "listed-post", post_type: "post", created_at: "2026-10-01T10:00:00Z", changed_at: "2026-10-01T10:00:00Z", title_html: "Listed <mark>post</mark>", excerpt_html: "Field &amp; notes" }],
        counts: { all: 1, post: 1, page: 0 },
        pagination: { page: 1, per_page: 10, total: 1, total_pages: 1 },
      })
    if (String(input) === `${SERVER_API_URL}/post-types`) return json(200, { post_types: [{ name: "post", label: "Posts", public: true, is_active: true }, { name: "page", label: "Pages", public: true, is_active: true }] })
    if (String(input) === `${SERVER_API_URL}/taxonomy/types`) return json(200, { taxonomy_types: [{ name: "category", label: "Categories", public: true }] })
    if (String(input) === `${SERVER_API_URL}/themes/active`) return json(200, { slug: "default", settings: {} })
    return json(404, { error: "not found" })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

let container: AstroContainer
beforeEach(async () => {
  container = await AstroContainer.create({ renderers: await loadRenderers([reactRenderer()]) })
  site.frontPageId = null
  api.mode = "override"
  api.overrideParts = {}
  stubApi()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const clean = (html: string) => html.replace(/\s+data-astro-source-(?:file|loc)="[^"]*"/g, "")
const locals = (extra: Partial<App.Locals> = {}) => ({ activeTheme: "default", ...extra }) as App.Locals

// Each route kind: how to render it, what its code layout shows, and the slugs it asks.
const ROUTES: { kind: string; slugs: string[]; code: string; render: () => Promise<Response> }[] = [
  { kind: "home", slugs: ["front-page", "home"], code: "home-header", render: () => container.renderToResponse(HomeRoute, { request: new Request("http://web:4321/"), locals: locals() }) },
  {
    kind: "front-page",
    slugs: ["front-page", "page"],
    code: "page--default",
    render: () => {
      site.frontPageId = 12
      return container.renderToResponse(HomeRoute, { request: new Request("http://web:4321/"), locals: locals() })
    },
  },
  {
    kind: "archive",
    slugs: ["archive-post", "archive"],
    code: "archive-header",
    render: () => container.renderToResponse(ArchiveRoute, { params: { post_type: "post" }, request: new Request("http://web:4321/post"), locals: locals() }),
  },
  {
    kind: "single",
    slugs: ["single-post", "single"],
    code: "post--default",
    render: () => container.renderToResponse(PostRoute, { params: { post_type: "post", id: "7" }, request: new Request("http://web:4321/post/7"), locals: locals() }),
  },
  {
    kind: "page",
    slugs: ["page"],
    code: "page--default",
    render: () => container.renderToResponse(PostRoute, { params: { post_type: "page", id: "8" }, request: new Request("http://web:4321/page/8"), locals: locals() }),
  },
  {
    kind: "term",
    slugs: ["taxonomy-category", "archive"],
    code: "term-header",
    render: () =>
      container.renderToResponse(TermRoute, { request: new Request("http://web:4321/category/guides"), locals: locals({ termArchive: { taxonomy: "category", slug: "guides" } }) }),
  },
  {
    kind: "author",
    slugs: ["author", "archive"],
    code: "author-header",
    render: () => container.renderToResponse(AuthorRoute, { params: { username: "ana" }, request: new Request("http://web:4321/author/ana"), locals: locals() }),
  },
  {
    kind: "search",
    slugs: ["search"],
    code: "search-page",
    render: () => container.renderToResponse(SearchRoute, { request: new Request("http://web:4321/search?q=notes"), locals: locals() }),
  },
  {
    kind: "404",
    slugs: ["404"],
    code: "error-page",
    render: () => container.renderToResponse(NotFoundRoute, { request: new Request("http://web:4321/missing"), locals: locals() }),
  },
]

// The first render of each route compiles its layouts, which takes seconds on a loaded machine.
describe("every route kind (design 3.2)", { timeout: 20_000 }, () => {
  for (const route of ROUTES.filter((r) => r.kind !== "term")) {
    // The template is customized where the default theme has a code layout of the same rank
    // (resolveBody). A term is below: its own term layout outranks a builder `archive`.
    it(`${route.kind}: a published override renders, a reset one falls back to the code layout`, async () => {
      api.mode = "override"
      const html = clean(await (await route.render()).text())
      expect(api.slugs).toEqual(route.slugs)
      expect(html).toContain(`BUILDER-${route.kind.toUpperCase()}`)
      expect(html).toContain("site--block-template")
      expect(html).not.toContain(route.code)

      api.mode = "reset"
      const code = clean(await (await route.render()).text())
      expect(code).not.toContain("BUILDER-")
      expect(code).not.toContain("site--block-template")
      expect(code).toContain(route.code)
    })
  }

  it("term: a builder `archive` doesn't beat the default theme's own term layout, `taxonomy-category` does", async () => {
    const term = ROUTES.find((r) => r.kind === "term")!
    // The resolve answers `archive` (rank 1): the active theme's term layout is at rank 0.
    api.mode = "override"
    let html = clean(await (await term.render()).text())
    expect(api.slugs).toEqual(term.slugs)
    expect(html).toContain("term-header")
    expect(html).not.toContain("BUILDER-")

    // An override at taxonomy-category (rank 0) wins.
    const fetchMock = stubApi()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/public/site-templates/resolve")) {
        return json(200, { theme: "default", template: { slug: "taxonomy-category", rank: 0, source: "override", title: "Categories", doc: templateDoc("term") }, parts: {}, menus: {} })
      }
      return original(input)
    })
    html = clean(await (await term.render()).text())
    expect(html).toContain("BUILDER-TERM")
    expect(html).not.toContain("term-header")
    // The route's own list, read once (an inheriting query fetches nothing more).
    expect(html).toContain("Listed post")
    const listReads = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/terms/guides/posts"))
    expect(listReads).toHaveLength(1)
  })

  it("a failed resolve renders the code layout, logged with the route kind", async () => {
    const warn = vi.spyOn(log, "warn")
    api.mode = "fail"
    const html = clean(await (await ROUTES.find((r) => r.kind === "single")!.render()).text())
    expect(html).toContain("post--default")
    expect(html).toContain("Published post")
    expect(warn).toHaveBeenCalledWith("site_template_resolve_failed", expect.objectContaining({ route_kind: "single" }))
  })

  it("the 500 page never resolves a template", async () => {
    const fetchMock = stubApi()
    const response = await container.renderToResponse(ServerErrorRoute, { request: new Request("http://web:4321/boom"), locals: locals(), props: { error: new Error("x") } })
    const html = clean(await response.text())
    expect(html).not.toContain("BUILDER-")
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/site-templates/"))).toBe(false)
  })
})

describe("BlockTemplateLayout (design 3.4)", { timeout: 20_000 }, () => {
  const single = () => ROUTES.find((r) => r.kind === "single")!.render()

  it("renders the starter header and footer of a template customized on the default theme until the parts are", async () => {
    const html = clean(await (await single()).text())
    // core's starter parts, in the part markup, before and after main#content.
    expect(html).toMatch(/<header class="template-part template-part--header">[\s\S]*class="site-title"[\s\S]*Field Notes[\s\S]*<\/header>\s*<main id="content" class="site-main" tabindex="-1">/)
    expect(html).toMatch(/<\/main>\s*<footer class="template-part template-part--footer">[\s\S]*Notes from the field[\s\S]*<\/footer>/)
    // Not the theme's own SiteHeader.
    expect(html).not.toContain('class="site-header"')

    // Once the header is customized, the override renders instead of the starter.
    api.overrideParts = { header: { source: "override", title: "Header", doc: docOf(["h-custom"], para("h-custom", "CUSTOM-HEADER")) } }
    const customized = clean(await (await single()).text())
    expect(customized).toContain("CUSTOM-HEADER")
    expect(customized).toContain("Notes from the field")
  })

  it("gives the template's blocks no b-<id> anchors and keeps the post's", async () => {
    const html = clean(await (await single()).text())
    expect(html).not.toContain('id="b-tpl-')
    expect(html).toContain('id="b-body-00001"')
    expect(html).toContain("The body of the post")
    // The post's body renders inside the template, with its site blocks inert.
    expect(html).toContain('<h1 class="title">Published post</h1>')
  })

  it("passes SeoHead exactly what the code layout does for the same post", async () => {
    const head = (html: string) => {
      const inner = clean(html).match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? ""
      // SeoHead's output: from <title> to the RSS link both layouts put right after it.
      return inner.slice(inner.indexOf("<title>"), inner.indexOf('<link rel="alternate" type="application/rss+xml"')).trim()
    }
    for (const kind of ["single", "page", "home", "archive", "author", "search"]) {
      const route = ROUTES.find((r) => r.kind === kind)!
      api.mode = "override"
      const builder = await (await route.render()).text()
      expect(builder, kind).toContain("site--block-template")
      api.mode = "reset"
      const code = await (await route.render()).text()
      expect(code, kind).not.toContain("site--block-template")
      expect(head(builder), kind).not.toBe("")
      expect(head(builder), kind).toBe(head(code))
    }
  })

  it("lists the route's own posts in an inheriting query, and search results with their text", async () => {
    const archive = clean(await (await ROUTES.find((r) => r.kind === "archive")!.render()).text())
    expect(archive).toContain("Listed post")
    expect(archive).toContain('<h1 class="title">Posts</h1>')
    const search = clean(await (await ROUTES.find((r) => r.kind === "search")!.render()).text())
    expect(search).toContain("Listed post")
    expect(search).toContain("Search results for “notes”")
  })
})

describe("<TemplatePart> in a code layout", () => {
  it("renders a published override part in place of the theme's markup, and the theme's otherwise", async () => {
    api.mode = "reset"
    api.overrideParts = { footer: { source: "override", title: "Footer", doc: docOf(["f-custom"], para("f-custom", "CUSTOM-FOOTER")) } }
    const html = clean(await (await ROUTES.find((r) => r.kind === "single")!.render()).text())
    expect(html).toContain("post--default")
    expect(html).toMatch(/<footer class="template-part template-part--footer">[\s\S]*CUSTOM-FOOTER[\s\S]*<\/footer>/)
    expect(html).not.toContain('id="b-f-custom"')
    // The header has no override: the theme's own SiteHeader.
    expect(html).toContain('class="site-header"')
  })

  it("renders nothing for a published part with no blocks, as a template does", async () => {
    api.mode = "reset"
    api.overrideParts = { footer: { source: "override", title: "Footer", doc: docOf([]) } }
    const html = clean(await (await ROUTES.find((r) => r.kind === "single")!.render()).text())
    expect(html).toContain("post--default")
    expect(html).not.toContain('class="site-footer"')
    expect(html).not.toContain("template-part--footer")
  })
})
