// The reader pages (#525, docs/design/reader-comments.md 11.6; the canvas's "Reader pages"
// board): /comments/confirm in the default theme, not indexed, one panel; its states without
// scripts and with gl-comments.js (run in a JSDOM window, the link's token in the fragment and
// fetch answered as the /gl-comments endpoints answer); the token spent only by the button. The
// unsubscribe page is served since #528; "your comments" waits for #529 (404). Both panels are
// tested alone too. axe passes on each state.
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import { getContainerRenderer as reactRenderer } from "@astrojs/react"
import { loadRenderers } from "astro:container"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { JSDOM } from "jsdom"

vi.mock("@/lib/siteSettings", () => ({
  getSiteSettings: async () => ({ title: "Field Notes", tagline: "", language: "en-US", timeZone: "UTC", dateFormat: "month_day_year" }),
}))
vi.mock("@/lib/menus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/menus")>()),
  getMenu: async () => null,
}))

const Confirm = (await import("./confirm.astro")).default
const Unsubscribe = (await import("./unsubscribe.astro")).default
const YourData = (await import("./your-data.astro")).default
const UnsubscribePanel = (await import("@/components/comments/reader/UnsubscribePanel.astro")).default
const YourDataPanel = (await import("@/components/comments/reader/YourDataPanel.astro")).default
const themeConfig = (await import("../../../themes/default/theme.config")).default
const { READER_PAGES_READY } = await import("@/lib/postComments")

const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8")
const SCRIPT = readFileSync(new URL("../../../public/gl-comments.js", import.meta.url), "utf8")
const TOKEN = "t".repeat(43)

let container: AstroContainer
beforeEach(async () => {
  container = await AstroContainer.create({ renderers: await loadRenderers([reactRenderer()]) })
})
const locals = { activeTheme: "default", themeAssets: themeConfig.assets }
const response = (component: unknown, query = "") =>
  container.renderToResponse(component as any, { request: new Request(`http://web:4321/comments/confirm${query}`), locals })

type Reply = (url: string, body: Record<string, unknown>) => { status: number; body?: unknown }
async function browse(html: string, hash = "", reply: Reply = () => ({ status: 500 }), scripts = true) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: `http://web:4321/comments/confirm${hash}` })
  await new Promise<void>((resolve) => (dom.window.document.readyState === "loading" ? dom.window.document.addEventListener("DOMContentLoaded", () => resolve()) : resolve()))
  const requests: { url: string; body: Record<string, unknown> }[] = []
  ;(dom.window as any).fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    requests.push({ url: String(url), body })
    const r = reply(String(url), body)
    return { status: r.status, json: async () => r.body ?? {} }
  })
  if (scripts) dom.window.eval(SCRIPT)
  return { dom, document: dom.window.document as Document, requests }
}
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const click = (dom: JSDOM, selector: string) => (dom.window.document.querySelector(selector) as HTMLElement).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }))

async function axe(dom: JSDOM, fragment = false) {
  dom.window.eval(AXE_SOURCE)
  const run = (dom.window as unknown as { axe: typeof import("axe-core") }).axe
  const result = await run.run(dom.window.document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    rules: { "color-contrast": { enabled: false }, ...(fragment ? { region: { enabled: false }, "landmark-one-main": { enabled: false } } : {}) },
  })
  return result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.html) }))
}
const panelTitle = (document: Document) => document.querySelector("[data-reader-panel] h1")?.textContent

describe("/comments/confirm", () => {
  it("renders in the theme, not indexed, with one panel that says it needs scripts", async () => {
    const res = await response(Confirm)
    expect(res.status).toBe(200)
    expect(res.headers.get("x-robots-tag")).toBe("noindex")
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
    const html = await res.text()
    expect(html).toMatch(/<meta name="robots" content="noindex/)
    expect(html).toContain("<title>Publish your comment | Field Notes</title>")
    expect(html).toContain('class="site-header"')
    // A file, never an inline script.
    expect(html).toContain('<script src="/gl-comments.js" defer></script>')
    expect(html.match(/<script(?![^>]*\bsrc=)[^>]*>/g) ?? []).toEqual([])
    const { dom, document } = await browse(html, "", undefined, false)
    expect(panelTitle(document)).toBe("This page needs JavaScript")
    expect(document.querySelectorAll("h1")).toHaveLength(1)
    expect(await axe(dom)).toEqual([])
  }, 30_000)

  it("with scripts: Publish my comment, and nothing spent on load", async () => {
    const { dom, document, requests } = await browse(await (await response(Confirm)).text(), `#token=${TOKEN}`)
    expect(panelTitle(document)).toBe("Publish your comment")
    expect(requests).toEqual([])
    expect(await axe(dom)).toEqual([])
  }, 30_000)

  it("the button confirms: waiting for review, then the address's other comments, each published or discarded", async () => {
    const reply: Reply = (url, body) => {
      if (url.endsWith("/gl-comments/confirm")) {
        return { status: 200, body: { outcome: "pending", comment_id: 5, post_url: "/post/hello", comment_url: "/post/hello#comments", others: [{ id: 8, post_title: "Analytics <b>for</b> every post", post_url: "/post/analytics", excerpt: "Does the reading time count?" }, { id: 9, post_title: "Roles", post_url: "https://evil.example/", excerpt: "Cheap pills" }] } }
      }
      return url.endsWith("/unconfirmed/9") && body.action === "discard" ? { status: 204 } : { status: 200, body: { outcome: "published" } }
    }
    const { dom, document, requests } = await browse(await (await response(Confirm)).text(), `#token=${TOKEN}`, reply)
    click(dom, "[data-reader-confirm]")
    await settle()
    expect(requests[0]).toEqual({ url: "/gl-comments/confirm", body: { token: TOKEN } })
    expect(panelTitle(document)).toBe("Your comment is waiting for review")
    expect(document.activeElement).toBe(document.querySelector("[data-reader-panel] h1"))
    expect(document.querySelector('[data-slot="post"]')!.getAttribute("href")).toBe("/post/hello")
    const items = [...document.querySelectorAll(".reader-list li")]
    expect(items.map((li) => li.querySelector("b")!.textContent)).toEqual(["Analytics <b>for</b> every post", "Roles"])
    // A post URL that isn't a path on this site stays the template's.
    expect(items[1].querySelector("a")!.getAttribute("href")).toBe("/")
    expect(items[0].querySelector('[data-reader-other="publish"]')!.getAttribute("aria-label")).toBe("Publish the comment on Analytics <b>for</b> every post")
    expect(await axe(dom)).toEqual([])
    click(dom, 'li[data-comment-id="9"] [data-reader-other="discard"]')
    await settle()
    expect(requests[1]).toEqual({ url: "/gl-comments/unconfirmed/9", body: { action: "discard" } })
    expect(items[1].querySelector(".reader-item-done")!.textContent).toBe("Discarded")
    expect(document.querySelector("[data-reader-live]")!.textContent).toBe("Discarded: Roles.")
    click(dom, 'li[data-comment-id="8"] [data-reader-other="publish"]')
    await settle()
    expect(items[0].querySelector(".reader-item-done")!.textContent).toBe("Published")
    expect(await axe(dom)).toEqual([])
  }, 30_000)

  it("published: a link to the comment", async () => {
    const { dom, document } = await browse(await (await response(Confirm)).text(), `#token=${TOKEN}`, () => ({ status: 200, body: { outcome: "published", post_url: "/post/hello", comment_url: "/post/hello#comment-5", others: [] } }))
    click(dom, "[data-reader-confirm]")
    await settle()
    expect(panelTitle(document)).toBe("Your comment is published")
    expect(document.querySelector('[data-slot="comment"]')!.getAttribute("href")).toBe("/post/hello#comment-5")
    expect(document.querySelector(".reader-list")).toBeNull()
  }, 30_000)

  it("a used-up or expired link, from the API or with no token at all", async () => {
    const html = await (await response(Confirm)).text()
    const used = await browse(html, `#token=${TOKEN}`, () => ({ status: 400, body: { code: "invalid_token" } }))
    click(used.dom, "[data-reader-confirm]")
    await settle()
    expect(panelTitle(used.document)).toBe("This link doesn’t work anymore")
    expect(await axe(used.dom)).toEqual([])
    expect(panelTitle((await browse(html)).document)).toBe("This link doesn’t work anymore")
  }, 30_000)

  it("a refusal says why (409 comments_closed)", async () => {
    const { dom, document } = await browse(await (await response(Confirm)).text(), `#token=${TOKEN}`, () => ({ status: 409, body: { code: "comments_closed" } }))
    click(dom, "[data-reader-confirm]")
    await settle()
    expect(panelTitle(document)).toBe("Your comment wasn’t published")
    expect(document.querySelector('[data-slot="reason"]')!.textContent).toBe("Comments on this post are closed.")
    // The token wasn't spent: Try again brings the button back.
    click(dom, "[data-reader-retry]")
    expect(panelTitle(document)).toBe("Publish your comment")
  }, 30_000)

  it("without scripts, a refused confirmation's ?error= renders at once, and the script leaves it", async () => {
    const invalid = await (await response(Confirm, "?error=invalid_token")).text()
    const { dom, document } = await browse(invalid, `#token=${TOKEN}`)
    expect(panelTitle(document)).toBe("This link doesn’t work anymore")
    expect(await axe(dom)).toEqual([])
    const closed = await (await response(Confirm, "?error=comments_closed")).text()
    expect(closed).toContain("Comments on this post are closed.")
    const odd = await (await response(Confirm, "?error=%3Cscript%3E")).text()
    expect(odd).toContain("publish your comment just now")
    expect(odd).not.toContain("<script>")
  }, 30_000)
})

describe("unsubscribe (#528) and your data (#529)", () => {
  it("are served once their routes are", async () => {
    expect(READER_PAGES_READY.unsubscribe).toBe(true)
    const unsubscribe = await response(Unsubscribe)
    expect(unsubscribe.status).toBe(200)
    expect(unsubscribe.headers.get("x-robots-tag")).toBe("noindex")
    expect((await response(YourData)).status).toBe(READER_PAGES_READY.yourData ? 200 : 404)
  })

  const fragment = async (component: unknown) => `<!doctype html><html lang="en"><head><title>Reader</title></head><body><main>${await container.renderToString(component as any, {})}</main></body></html>`

  it("unsubscribe: Stop these emails, or all mail, then done", async () => {
    const html = await fragment(UnsubscribePanel)
    expect(panelTitle((await browse(html, "", undefined, false)).document)).toBe("This page needs JavaScript")
    const { dom, document, requests } = await browse(html, `#token=${TOKEN}`, () => ({ status: 204 }))
    expect(panelTitle(document)).toBe("Stop reply emails?")
    expect(await axe(dom, true)).toEqual([])
    click(dom, '[data-reader-unsubscribe="all"]')
    await settle()
    expect(requests[0]).toEqual({ url: "/gl-comments/unsubscribe", body: { token: TOKEN, all: true } })
    expect(panelTitle(document)).toBe("You won’t get mail from this site any more")
    expect(await axe(dom, true)).toEqual([])
  }, 30_000)

  it("your data: ask for a link, then the list, delete one, delete everything (asked first)", async () => {
    const html = await fragment(YourDataPanel)
    const ask = await browse(html, "", () => ({ status: 202 }))
    expect(panelTitle(ask.document)).toBe("Your comments")
    expect(await axe(ask.dom, true)).toEqual([])
    ;(ask.document.querySelector("#reader-email") as HTMLInputElement).value = "jonas@example.com"
    ask.document.querySelector("form")!.dispatchEvent(new ask.dom.window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    expect(ask.requests[0]).toEqual({ url: "/gl-comments/data-request", body: { email: "jonas@example.com" } })
    expect(panelTitle(ask.document)).toBe("Check your email")

    const data = { commenter: { email: "jonas@example.com" }, comments: [{ id: 3, post_title: "Writing alt text", post_url: "/post/alt", status: "pending", created_at: "2026-11-12T10:00:00Z", body: "What about icons?" }] }
    const list = await browse(html, `#token=${TOKEN}`, (url) => (url.endsWith("/gl-comments/data") ? { status: 200, body: data } : { status: 204 }))
    await settle()
    expect(list.requests[0]).toEqual({ url: "/gl-comments/data", body: { token: TOKEN } })
    expect(list.document.querySelector('[data-slot="email"]')!.textContent).toBe("jonas@example.com")
    expect(list.document.querySelector(".reader-list li [data-slot='status']")!.textContent).toBe("Waiting for review")
    expect(await axe(list.dom, true)).toEqual([])
    click(list.dom, "[data-reader-delete]")
    await settle()
    expect(list.requests[1]).toEqual({ url: "/gl-comments/data/delete", body: { token: TOKEN, comment_id: 3 } })
    click(list.dom, "[data-reader-erase-ask]")
    expect(panelTitle(list.document)).toBe("Delete everything?")
    // The one comment is already deleted: the count follows.
    expect(list.document.querySelector("[data-reader-panel]")!.textContent).toContain("This deletes your comments and everything this site keeps about jonas@example.com.")
    expect(await axe(list.dom, true)).toEqual([])
    click(list.dom, "[data-reader-erase]")
    await settle()
    expect(list.requests[2]).toEqual({ url: "/gl-comments/data/delete", body: { token: TOKEN } })
    expect(panelTitle(list.document)).toBe("Your comments and address are deleted")
  }, 30_000)
})
