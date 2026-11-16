// Render time of a block template against the theme's code layout on the same route (#491's
// acceptance, design 11): the post route and the post type archive, each rendered with the
// default theme's code layout and with a builder template that shows the same things (core's
// interim starter shapes, with the starter header and footer). The API is a stub that answers
// at once, so the numbers are the web server's own work per request; the builder path's one
// extra network read (the cached resolve) is measured on the API side separately.
//
// Off by default (it takes a while and prints numbers): GL_MEASURE_RENDER=1 npx vitest run
// --project astro src/layouts/blockTemplateRenderTime.astro.test.ts
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import { getContainerRenderer as reactRenderer } from "@astrojs/react"
import { loadRenderers } from "astro:container"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/siteSettings", () => ({
  getSiteSettings: async () => ({ title: "Field Notes", tagline: "Notes", language: "en", timeZone: "UTC", dateFormat: "long", postsPerPage: 10, urlStructure: "id", frontPageId: null, logo: null }),
}))
vi.mock("@/lib/menus", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/menus")>()), getMenu: async () => null }))

const { SERVER_API_URL } = await import("@gl-admin/lib/server-api-url")
const PostRoute = (await import("../pages/[post_type]/[id].astro")).default
const ArchiveRoute = (await import("../pages/[post_type]/index.astro")).default

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
// core's interim starters, as the resolve route serves them.
const read = (file: string) => JSON.parse(readFileSync(path.resolve(process.cwd(), "../api/sitedesign/starters", file), "utf8")).doc

// A post body of a realistic length: 12 paragraphs and 4 headings.
const ids = Array.from({ length: 16 }, (_, i) => `blk-${String(i).padStart(6, "0")}`)
const text = "Field notes are short, plain records of what happened, written while the details are still fresh. ".repeat(3)
const body = {
  doc_version: 1,
  blocks_order: ids,
  blocks: Object.fromEntries(
    ids.map((id, i) =>
      i % 4 === 0
        ? [id, { id, type: "heading", version: 1, attrs: { level: 2, text: `Section ${i / 4 + 1}`, pm: { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: `Section ${i / 4 + 1}` }] } } }]
        : [id, { id, type: "paragraph", version: 1, attrs: { text, pm: { type: "paragraph", content: [{ type: "text", text }] } } }],
    ),
  ),
}
const post = (id: number, title: string) => ({
  id,
  title,
  description: `About ${title}`,
  slug: `post-${id}`,
  post_type: "post",
  post_status: "published",
  user_id: 1,
  username: "ana",
  created_at: "2026-10-01T10:00:00Z",
  changed_at: "2026-10-02T10:00:00Z",
  published_blocks: body,
})

function stub(mode: "code" | "builder") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const path = url.pathname
      if (path.endsWith("/public/site-templates/resolve")) {
        if (mode === "code") return json(200, { theme: "default", template: null, parts: {}, menus: {} })
        const slugs = (url.searchParams.get("slugs") ?? "").split(",")
        const slug = slugs[slugs.length - 1]
        return json(200, {
          theme: "default",
          template: { slug, rank: slugs.length - 1, source: "override", title: slug, doc: read(`templates/${slug}.json`) },
          parts: { header: { source: "starter", title: "Header", doc: read("parts/header.json") }, footer: { source: "starter", title: "Footer", doc: read("parts/footer.json") } },
          menus: {},
        })
      }
      if (path === "/public/posts/7") return json(200, { post: post(7, "Published post"), featured_image: null, taxonomy_terms: [] })
      if (/\/public\/posts\/7\/authors$/.test(path)) return json(200, { authors: [] })
      if (/\/public\/posts\/7\/adjacent$/.test(path)) return json(200, { previous: post(6, "Older"), next: post(8, "Newer") })
      if (/\/public\/posts\/7\/related$/.test(path)) return json(200, { posts: [post(5, "Related")] })
      if (path.startsWith("/public/posts/type/post"))
        return json(200, { posts: Array.from({ length: 10 }, (_, i) => post(20 + i, `Listed ${i}`)), pagination: { page: 1, per_page: 10, total: 30, total_pages: 3 } })
      if (String(input) === `${SERVER_API_URL}/post-types`) return json(200, { post_types: [{ name: "post", label: "Posts", public: true, is_active: true }] })
      if (String(input) === `${SERVER_API_URL}/taxonomy/types`) return json(200, { taxonomy_types: [] })
      if (String(input) === `${SERVER_API_URL}/themes/active`) return json(200, { slug: "default", settings: {} })
      return json(404, {})
    }),
  )
}

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((values.length * p) / 100))]

describe.skipIf(!process.env.GL_MEASURE_RENDER)("render time: block template vs code layout (#491)", () => {
  it("measures the post route and the archive", { timeout: 600_000 }, async () => {
    const container = await AstroContainer.create({ renderers: await loadRenderers([reactRenderer()]) })
    const routes = {
      "post /post/7": () => container.renderToResponse(PostRoute, { params: { post_type: "post", id: "7" }, request: new Request("http://web:4321/post/7"), locals: { activeTheme: "default" } as App.Locals }),
      "archive /post": () => container.renderToResponse(ArchiveRoute, { params: { post_type: "post" }, request: new Request("http://web:4321/post"), locals: { activeTheme: "default" } as App.Locals }),
    }
    const runs = Number(process.env.GL_MEASURE_RUNS ?? 300)
    const rows: string[] = []
    for (const [name, render] of Object.entries(routes)) {
      const times: Record<"code" | "builder", number[]> = { code: [], builder: [] }
      for (let i = 0; i < 30; i++) for (const mode of ["code", "builder"] as const) (stub(mode), await (await render()).text())
      for (let i = 0; i < runs; i++) {
        for (const mode of i % 2 ? (["code", "builder"] as const) : (["builder", "code"] as const)) {
          stub(mode)
          const start = performance.now()
          const html = await (await render()).text()
          times[mode].push(performance.now() - start)
          expect(html.includes("site--block-template")).toBe(mode === "builder")
        }
      }
      for (const mode of ["code", "builder"] as const) {
        rows.push(`${name} ${mode}: median ${percentile(times[mode], 50).toFixed(2)} ms, p95 ${percentile(times[mode], 95).toFixed(2)} ms (${runs} runs)`)
      }
    }
    vi.unstubAllGlobals()
    console.log(`\nRENDER TIME (node ${process.version})\n${rows.join("\n")}\n`)
  })
})
