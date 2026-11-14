// The theme contract's components (#484, design 3.5): ThemeScripts and TemplatePart render
// exactly what a theme's own markup did, and a theme that adopts none of the contract still
// renders.
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import { getContainerRenderer as reactRenderer } from "@astrojs/react"
import { loadRenderers } from "astro:container"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { themeConfig as testThemeConfig } from "../../themes/test/theme.config"
import { NO_GLOBAL_STYLES } from "@/lib/themeTokens"
import { log } from "@/lib/log"

vi.mock("@/lib/menus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/menus")>()),
  getMenu: async () => null,
}))
vi.mock("@/lib/siteSettings", () => ({
  getSiteSettings: async () => ({ title: "Field Notes", tagline: "", postsPerPage: 10, urlStructure: "slug", language: "en-US", timeZone: "UTC", dateFormat: "month_day_year" }),
}))

const ThemeScripts = (await import("./ThemeScripts.astro")).default
const TemplatePart = (await import("./TemplatePart.astro")).default
const TestThemePost = (await import("../../themes/test/layouts/post/default.astro")).default

const request = new Request("http://web:4321/post/hello-world")
let container: AstroContainer
beforeEach(async () => {
  container = await AstroContainer.create({ renderers: await loadRenderers([reactRenderer()]) })
})
const clean = (html: string) => html.replace(/\s+data-astro-source-(?:file|loc)="[^"]*"/g, "")

const scripts = [
  { src: "/themes/x/init.js", blocking: true, data: { "storage-key": "x-theme" } },
  { src: "/themes/x/app.js", defer: true },
  { src: "/themes/x/stats.js", async: true, type: "module" },
]

describe("ThemeScripts", () => {
  it("head: the blocking scripts, plain <script src> with their data attributes", async () => {
    const html = clean(await container.renderToString(ThemeScripts, { props: { scripts, placement: "head" } }))
    expect(html.trim()).toBe('<script src="/themes/x/init.js" data-storage-key="x-theme"></script>')
  })

  it("body: the rest, with defer, async and type", async () => {
    const html = clean(await container.renderToString(ThemeScripts, { props: { scripts, placement: "body" } }))
    expect(html.trim()).toBe('<script src="/themes/x/app.js" defer></script><script src="/themes/x/stats.js" async type="module"></script>')
  })

  it("nothing without scripts", async () => {
    expect((await container.renderToString(ThemeScripts, { props: { placement: "head" } })).trim()).toBe("")
  })
})

describe("TemplatePart", () => {
  it("renders its slot and no markup of its own until #491", async () => {
    const html = await container.renderToString(TemplatePart, { props: { slug: "header" }, slots: { default: '<header class="site-header">Hi</header>' } })
    expect(html).toBe('<header class="site-header">Hi</header>')
  })

  it("an invalid slug still renders the slot", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {})
    const html = await container.renderToString(TemplatePart, { props: { slug: "Not  A Slug" }, slots: { default: "<footer>Bye</footer>" } })
    expect(html).toBe("<footer>Bye</footer>")
    expect(warn).toHaveBeenCalledWith("template_part_slug_invalid", { slug: "Not  A Slug" })
    warn.mockRestore()
  })
})

describe("a theme that doesn't adopt the contract (#484)", () => {
  it("still renders: its own head script, its assets, and global styles are ignored", async () => {
    const post = { id: 1, title: "Hello World", description: "", user_id: 1, username: "admin", url: "", slug: "hello-world", post_type: "post", post_status: "published", menu_order: 0, created_at: "2026-10-01T10:00:00Z", changed_at: "2026-10-01T10:00:00Z" }
    const html = clean(
      await container.renderToString(TestThemePost, {
        props: { post, title: "Hello World", description: "d" },
        request,
        locals: { activeTheme: "test", themeAssets: testThemeConfig.assets, globalStyles: NO_GLOBAL_STYLES },
      }),
    )
    expect(html).toContain('<h1 class="post-title">Hello World</h1>')
    for (const style of testThemeConfig.assets?.styles ?? []) expect(html).toContain(`href="${style.src}"`)
    expect(html).toContain("localStorage.getItem(storageKey)")
    expect(html).not.toContain("theme-init.js")
  })
})
