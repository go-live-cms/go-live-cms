// The comments section (#525, docs/design/reader-comments.md 11.1 to 11.5), rendered by Astro's
// container: every state of 11.2, comment text as text (never markup) with its links' rel, no
// address on the page, and axe over the section and the form in each state, the ones
// gl-comments.js draws included (it runs in a JSDOM window over the rendered page, with fetch
// answered as the /gl-comments endpoint answers it).
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import { getContainerRenderer as reactRenderer } from "@astrojs/react"
import { loadRenderers } from "astro:container"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { JSDOM } from "jsdom"
import type { PublicReaderComment, PublicReaderCommentThread } from "@/lib/api"
import type { PostCommentsData } from "@/lib/postComments"

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock("@/lib/siteSettings", () => ({
  getSiteSettings: async () => ({ title: "Field Notes", language: "en-US", timeZone: "UTC", dateFormat: "month_day_year", ...settings.value }),
}))

const PostComments = (await import("./PostComments.astro")).default
const { avatarColor } = await import("@/lib/bylines")
const { readerCommentRuns } = await import("@/lib/discussion")
const { COMMENT_CODE_REASONS } = await import("@/lib/commentFormFields")

const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8")
const SCRIPT = readFileSync(new URL("../../../public/gl-comments.js", import.meta.url), "utf8")

const comment = (id: number, extra: Partial<PublicReaderComment> = {}): PublicReaderComment => ({
  id,
  parent_id: null,
  root_id: null,
  name: `Reader ${id}`,
  badge: null,
  avatar: null,
  body: `Comment ${id}`,
  created_at: "2026-11-17T08:40:00Z",
  edited: false,
  removed: false,
  replying_to: null,
  ...extra,
})
const t = (root: PublicReaderComment, replies: PublicReaderComment[] = []): PublicReaderCommentThread => ({ comment: root, replies, reply_count: replies.length })
// The board's thread: replies with the Author and Staff badges, "Replying to", a tombstone, a link.
const BOARD: PublicReaderCommentThread[] = [
  t(comment(101, { name: "Kenji Mori", body: "Can I see afterwards who changed a paragraph?" }), [
    comment(102, { parent_id: 101, root_id: 101, name: "Luan", badge: "author", body: "Not yet: the history shows versions." }),
    comment(105, { parent_id: 102, root_id: 101, name: "Maya Lindqvist", replying_to: "Luan", body: "We tried it with three editors." }),
  ]),
  t(comment(110, { removed: true, name: "", body: "" }), [comment(111, { parent_id: 110, root_id: 110, name: "Priya Nair", body: "It had fewer features." }), comment(112, { parent_id: 111, root_id: 110, name: "Sofia Lund", badge: "staff", replying_to: "Priya Nair", body: "The old shortcuts stay." })]),
  t(comment(120, { name: "Tom Okafor", body: "I wrote up how we moved our team over:\nhttps://okafor.example/notes/moving-to-golive\n\nThe redirects took the longest." })),
]
const answer = (state: "open" | "closed" | "off", threads: PublicReaderCommentThread[], extra: Partial<PostCommentsData> = {}): PostCommentsData => ({
  discussion: { state, closes_at: null, count: 6 },
  threads,
  pagination: { page: 1, per_page: 3, total: 6, total_pages: 2 },
  ...extra,
})

let container: AstroContainer
beforeEach(async () => {
  container = await AstroContainer.create({ renderers: await loadRenderers([reactRenderer()]) })
  settings.value = {}
})

const render = (comments: PostCommentsData | null, query = "") =>
  container.renderToString(PostComments as any, { props: { post: { id: 42 }, comments }, request: new Request(`http://web:4321/post/hello${query}`) })

/** The section in a page, gl-comments.js run over it, `fetch` answered by `reply`. */
async function page(html: string, reply?: (url: string, body: Record<string, unknown>) => { status: number; body?: unknown }) {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head><title>Hello</title></head><body><main>${html}</main></body></html>`, { runScripts: "outside-only", url: "http://web:4321/post/hello" })
  const requests: { url: string; body: Record<string, unknown>; init: RequestInit }[] = []
  await new Promise<void>((resolve) => (dom.window.document.readyState === "loading" ? dom.window.document.addEventListener("DOMContentLoaded", () => resolve()) : resolve()))
  ;(dom.window as any).fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    requests.push({ url: String(url), body, init })
    const r = reply ? reply(String(url), body) : { status: 500 }
    return { status: r.status, json: async () => r.body ?? {} }
  })
  dom.window.eval(SCRIPT)
  return { dom, document: dom.window.document as Document, requests }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function axe(dom: JSDOM, context?: string) {
  dom.window.eval(AXE_SOURCE)
  const run = (dom.window as unknown as { axe: typeof import("axe-core") }).axe
  const result = await run.run(context ? (dom.window.document.querySelector(context) as any) : dom.window.document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    // jsdom does no layout: contrast is tokens.test.ts's; a fragment has no page landmarks.
    rules: { "color-contrast": { enabled: false }, region: { enabled: false }, "landmark-one-main": { enabled: false }, "page-has-heading-one": { enabled: false } },
  })
  return result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.html) }))
}

describe("what the section shows (11.2)", () => {
  it("off: nothing at all", async () => {
    expect((await render(answer("off", BOARD))).trim()).toBe("")
  })

  it("closed with no comments: nothing; no answer (a failed read): nothing", async () => {
    expect((await render(answer("closed", []))).trim()).toBe("")
    expect((await render(null)).trim()).toBe("")
  })

  it("closed with comments: the threads, then Comments are closed, no Reply, no form, no script", async () => {
    const html = await render(answer("closed", BOARD))
    expect(html).toContain('<p class="comments-closed">Comments are closed.</p>')
    expect(html).not.toContain('class="comment-reply"')
    expect(html).not.toContain("<form")
    expect(html).not.toContain("gl-comments.js")
  })

  it("open with none: the heading without a count, No comments yet., the form", async () => {
    const html = await render(answer("open", [], { discussion: { state: "open", closes_at: null, count: 0 }, pagination: null }))
    expect(html).toContain('<h2 class="comments-title" id="comments-title">Comments</h2>')
    expect(html).toContain('<p class="comments-empty">No comments yet.</p>')
    const form = (await page(html)).document.querySelector("form#comment-form.comment-form")!
    expect([form.getAttribute("method"), form.getAttribute("action")]).toEqual(["post", "/gl-comments/posts/42"])
    expect(html).toContain('<script src="/gl-comments.js" defer=""></script>')
  })

  it("open: the title and the count, threads, replies, badges, a tombstone, the pager, the form", async () => {
    const html = await render(answer("open", BOARD))
    const { document } = await page(html)
    expect(document.querySelector(".comments-title")!.textContent).toBe("Comments 6")
    expect(document.querySelector(".comments-count")!.textContent).toBe("6")
    expect(document.querySelectorAll(".comment-list > li")).toHaveLength(3)
    expect(document.querySelectorAll(".comment-replies > li")).toHaveLength(4)
    expect([...document.querySelectorAll(".comment-badge")].map((b) => b.textContent)).toEqual(["Author", "Staff"])
    expect(document.querySelector("#comment-110")!.matches("article.comment.comment-removed[aria-label='Removed comment']")).toBe(true)
    expect(document.querySelector("#comment-110")!.textContent).toBe("This comment was removed")
    expect(document.querySelector("#comment-105 .comment-replyto")!.textContent).toBe("Replying to Luan")
    expect(document.querySelector("#comment-105 .comment-replyto a")!.getAttribute("href")).toBe("#comment-102")
    expect(document.querySelector("#comment-101")!.getAttribute("aria-labelledby")).toBe("comment-101-name")
    expect(document.querySelector("#comment-101 time")!.outerHTML).toBe('<time datetime="2026-11-17T08:40:00Z">November 17, 2026</time>')
    expect(document.querySelector("#comment-101 a.comment-reply")!.getAttribute("href")).toBe("/post/hello?replyto=101#comment-form")
    expect(document.querySelector("nav.comments-pagination")!.getAttribute("aria-label")).toBe("Comment pages")
    expect(document.querySelector('nav.comments-pagination a[rel="next"]')!.getAttribute("href")).toBe("/post/hello?comments=2#comments")
    // The form, in the board's order, its status region empty from the start (#477).
    const form = document.querySelector("form.comment-form")!
    expect([...form.children].map((c) => c.className || c.tagName)).toEqual(["H3", "comment-status", "comment-field", "comment-fields", "comment-check", "comment-hp", "INPUT", "comment-submit", "comment-privacy"])
    expect(form.querySelector('[role="status"]')!.innerHTML).toBe("")
    expect([...form.querySelectorAll("input, textarea")].map((i) => i.getAttribute("name"))).toEqual(["comment", "name", "email", "notify_replies", "website", "return_to"])
    expect((form.querySelector('[name="notify_replies"]') as HTMLInputElement).checked).toBe(false)
    expect(form.querySelector(".comment-privacy")!.textContent).toContain("Your email is never shown.")
  })

  it("the avatars are the bylines' colours, or a member's picture", async () => {
    const html = await render(answer("open", [t(comment(1, { name: "Kenji Mori" })), t(comment(2, { avatar: "/uploads/_avatars/avatar-0123456789abcdef0123456789abcdef.png" }))]))
    expect(html).toContain(`<span class="avatar" aria-hidden="true" style="background:${avatarColor("Kenji Mori")}">K</span>`)
    expect(html).toContain('<img src="/uploads/_avatars/avatar-0123456789abcdef0123456789abcdef.png" alt=""')
  })

  it("?replyto=: Reply to Ana, Replying to Ana · Cancel, the hidden parent", async () => {
    const html = await render(answer("open", [t(comment(7, { name: "Ana" }))]), "?replyto=7")
    expect(html).toContain('<h3 id="comment-form-title">Reply to Ana</h3>')
    expect(html).toMatch(/<p class="comment-form-replying"><span>Replying to <a href="#comment-7">Ana<\/a><\/span><a href="\/post\/hello#comment-form" data-reply-cancel="">Cancel<\/a><\/p>/)
    expect(html).toContain('<input type="hidden" name="parent_id" value="7"/>')
  })

  it("?commented=: the redirect's notice in the status region", async () => {
    const html = await render(answer("open", BOARD), "?commented=confirm")
    expect(html).toContain("Check your email to publish your comment")
  })

  it("the site's own notice and its privacy page", async () => {
    settings.value = { comments: { threading: "replies", notice: "We keep comments for a year.", privacyHref: "/page/12" } }
    const html = await render(answer("open", BOARD))
    expect(html).toMatch(/<p class="comment-privacy">We keep comments for a year\. <a href="\/page\/12">Privacy<\/a><\/p>/)
  })
})

describe("comment text is text (6.3, 5.4)", () => {
  const evil = comment(1, {
    name: '<img src=x onerror="alert(1)">',
    body: 'Hi </p><script>alert(1)</script> <b>bold</b>\nhttps://x.example/"onmouseover="alert(1) and javascript:alert(1)',
  })

  it("escapes names and bodies; links only http(s), with rel nofollow ugc noopener", async () => {
    const html = await render(answer("open", [t(evil)]))
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).not.toContain("<img src=x")
    expect(html).not.toContain("<b>bold</b>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    const { document } = await page(html)
    const links = [...document.querySelectorAll(".comment-text a")]
    expect(links.map((a) => [a.getAttribute("href"), a.getAttribute("rel")])).toEqual([["https://x.example/", "nofollow ugc noopener"]])
    expect(document.querySelector(".comment-author")!.textContent).toBe('<img src=x onerror="alert(1)">')
    expect(document.querySelectorAll(".comment-text br")).toHaveLength(1)
  })

  it("no comments component uses set:html or dangerouslySetInnerHTML", () => {
    for (const file of ["./PostComments.astro", "./PostCommentsSection.tsx", "./CommentRefused.astro", "./reader/ConfirmPanel.astro", "./reader/UnsubscribePanel.astro", "./reader/YourDataPanel.astro"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8")
      expect(source, file).not.toMatch(/set:html|dangerouslySetInnerHTML/)
    }
    // The script writes the API's values with textContent and attributes, never as markup.
    expect(SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
  })

  it("hides the honeypot in the markup, whatever the theme styles (5.2)", async () => {
    const { document } = await page(await render(answer("open", BOARD)))
    const box = document.querySelector(".comment-hp") as HTMLElement
    expect(box.getAttribute("aria-hidden")).toBe("true")
    expect(box.style.position).toBe("absolute")
    expect(box.style.left).toBe("-10000px")
    expect(box.querySelector('[name="website"]')!.getAttribute("tabindex")).toBe("-1")
  })

  it("never shows an address (7.1)", async () => {
    const html = await render(answer("open", [t(comment(1, { name: "Maya", body: "Write to me" }))]))
    expect(html).not.toMatch(/@[a-z0-9-]+\.[a-z]/i)
  })
})

describe("gl-comments.js (11.4)", () => {
  const typed = { body: "Does this work with the Markdown shortcuts turned on?", name: "Jonas Berg", email: "jonas@example.com" }
  const fill = (document: Document, values: Partial<typeof typed> = typed) => {
    for (const [name, value] of Object.entries(values)) (document.querySelector(`[name="${name === "body" ? "comment" : name}"]`) as HTMLInputElement).value = value
    document.querySelector("textarea")!.dispatchEvent(new document.defaultView!.Event("input"))
  }
  const submit = async (document: Document) => {
    document.querySelector("form")!.dispatchEvent(new document.defaultView!.Event("submit", { cancelable: true }))
    await settle()
    await settle()
  }

  it("copies the server's link rule, colours and reasons", async () => {
    const { dom } = await page("")
    const copy = (dom.window as any).__glComments
    for (const line of ["See https://a.example/x), and (https://b.example/y).", "no links", "http://", "https://okafor.example/notes/moving-to-golive?x=1#y!"]) {
      expect(copy.runs(line)).toEqual(readerCommentRuns(line))
    }
    for (const name of ["Kenji Mori", "Ana", "Ünïcødé 名前"]) expect(copy.avatarColor(name)).toBe(avatarColor(name))
    expect(copy.reasons).toEqual(COMMENT_CODE_REASONS)
  })

  it("counts characters as the API does (code points)", async () => {
    const { document } = await page(await render(answer("open", BOARD)))
    fill(document, { body: "héllo 👋" })
    expect(document.querySelector(".comment-count")!.textContent).toBe("7 / 4,000")
  })

  it("field errors: the summary, each field tied to its message, focus on the first (11.5)", async () => {
    const { dom, document, requests } = await page(await render(answer("open", BOARD)))
    fill(document, { body: typed.body, name: "", email: "jonas@example" })
    await submit(document)
    expect(requests).toHaveLength(0)
    expect(document.querySelector(".comment-status")!.textContent).toBe("Your comment wasn’t postedFix the 2 fields marked below, then post it again.")
    const name = document.querySelector("#comment-name")!
    expect(name.getAttribute("aria-invalid")).toBe("true")
    expect(name.getAttribute("aria-describedby")).toBe("comment-name-error")
    expect(document.getElementById("comment-name-error")!.textContent).toBe("Enter your name.")
    expect(document.getElementById("comment-email-error")!.textContent).toBe("“jonas@example” isn’t a complete email address.")
    expect(document.activeElement).toBe(name)
    expect(await axe(dom, ".comments")).toEqual([])
  })

  it("an API field error lands on its field", async () => {
    const { document } = await page(await render(answer("open", BOARD)), () => ({ status: 400, body: { code: "name_too_long", fields: { name: "the name is too long" } } }))
    fill(document)
    await submit(document)
    expect(document.getElementById("comment-name-error")!.textContent).toBe("Your name is too long: 60 characters at most.")
  })

  it("without a key: Check your email, and the form is cleared", async () => {
    const { dom, document, requests } = await page(await render(answer("open", BOARD)), () => ({ status: 202, body: { outcome: "confirm_email", post_url: "/post/hello" } }))
    fill(document)
    await submit(document)
    expect(requests[0].url).toBe("http://web:4321/gl-comments/posts/42")
    expect(requests[0].body).toMatchObject({ comment: typed.body, name: typed.name, email: typed.email, website: "", return_to: "/post/hello" })
    expect((requests[0].init.headers as Record<string, string>).Accept).toBe("application/json")
    expect(document.querySelector(".comment-notice.is-success b")!.textContent).toBe("Check your email to publish your comment")
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("")
    expect(await axe(dom, ".comments")).toEqual([])
  })

  it("with a key, held: shown in place as awaiting moderation, the count unchanged", async () => {
    const { dom, document } = await page(await render(answer("open", BOARD)), () => ({ status: 202, body: { outcome: "pending", comment_id: 130 } }))
    fill(document)
    await submit(document)
    const own = document.querySelector("#comment-130")!
    expect(own.matches("article.comment.is-own")).toBe(true)
    expect(own.querySelector(".comment-pending")!.textContent).toBe("Awaiting moderation · only you can see this")
    expect(own.querySelector(".comment-author")!.textContent).toBe("Jonas Berg")
    expect(document.querySelector(".comments-count")!.textContent).toBe("6")
    expect(document.querySelector(".comment-status b")!.textContent).toBe("Thanks. Your comment is waiting for review")
    expect(await axe(dom, ".comments")).toEqual([])
  })

  it("with a key, published: inserted at the end, its text as text, the count up by one", async () => {
    const { dom, document } = await page(await render(answer("open", BOARD)), () => ({ status: 201, body: { outcome: "published", comment_id: 131 } }))
    fill(document, { ...typed, body: "<b>hi</b> https://a.example/x." })
    await submit(document)
    const last = [...document.querySelectorAll(".comment-list > li")].pop()!
    expect(last.querySelector("article")!.id).toBe("comment-131")
    expect(last.querySelector(".comment-text")!.innerHTML).toBe('<p>&lt;b&gt;hi&lt;/b&gt; <a href="https://a.example/x" rel="nofollow ugc noopener">https://a.example/x</a>.</p>')
    expect(document.querySelector(".comments-count")!.textContent).toBe("7")
    expect(await axe(dom, ".comments")).toEqual([])
  })

  it.each([
    ["rate limited (429)", 429, { code: "" }, "Your comment wasn’t posted", "faster than this site allows"],
    ["too many waiting (429 comments_busy)", 429, { code: "comments_busy" }, "Your comment wasn’t posted", "Too many comments are waiting"],
    ["closed since the page loaded (409)", 409, { code: "comments_closed" }, "Comments on this post are closed", "Your text is still here"],
    ["the site couldn't answer", 502, {}, "Your comment wasn’t posted", "couldn't take your comment"],
  ])("%s: the reason, and the text stays", async (_name, status, body, title, text) => {
    const { dom, document } = await page(await render(answer("open", BOARD)), () => ({ status, body }))
    fill(document)
    await submit(document)
    expect(document.querySelector(".comment-notice.is-error b")!.textContent).toBe(title)
    expect(document.querySelector(".comment-notice.is-error p")!.textContent).toContain(text)
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe(typed.body)
    expect(await axe(dom, ".comments")).toEqual([])
  })

  it("Reply moves the form under the comment, and the reply goes into that thread", async () => {
    const { dom, document, requests } = await page(await render(answer("open", BOARD)), () => ({ status: 201, body: { outcome: "published", comment_id: 140 } }))
    const reply = document.querySelector('#comment-105 a.comment-reply') as HTMLAnchorElement
    reply.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }))
    const form = document.querySelector("form.comment-form")!
    expect(form.previousElementSibling!.id).toBe("comment-105")
    expect(form.querySelector("h3")!.textContent).toBe("Reply to Maya Lindqvist")
    expect(form.querySelector(".comment-form-replying")!.textContent).toBe("Replying to Maya LindqvistCancel")
    expect((form.querySelector('[name="parent_id"]') as HTMLInputElement).value).toBe("105")
    expect(document.activeElement).toBe(form.querySelector("textarea"))
    expect(await axe(dom, ".comments")).toEqual([])
    fill(document)
    await submit(document)
    expect(requests[0].body.parent_id).toBe("105")
    expect(document.querySelector(".comment-status p")!.textContent).toBe("It’s under the comment you replied to.")
    expect(document.querySelector("#comment-140")!.closest(".comment-replies")).toBe(document.querySelector("#comment-101")!.closest("li")!.querySelector(".comment-replies"))
    // The form is back at the end of the section, a new comment again.
    expect(form.parentElement!.matches("section.comments")).toBe(true)
    expect(form.querySelector('[name="parent_id"]')).toBeNull()
    expect(form.querySelector("h3")!.textContent).toBe("Leave a comment")
  })

  it("Cancel puts the form back", async () => {
    const { dom, document } = await page(await render(answer("open", BOARD)))
    ;(document.querySelector("#comment-101 a.comment-reply") as HTMLElement).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }))
    ;(document.querySelector("[data-reply-cancel]") as HTMLElement).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }))
    const form = document.querySelector("form.comment-form")!
    expect(form.parentElement!.matches("section.comments")).toBe(true)
    expect(form.querySelector(".comment-form-replying")).toBeNull()
  })
})

describe("axe (11.5)", () => {
  it.each([
    ["open, with threads", answer("open", BOARD), ""],
    ["open, none yet", answer("open", [], { discussion: { state: "open", closes_at: null, count: 0 }, pagination: null }), ""],
    ["closed, with comments", answer("closed", BOARD), ""],
    ["reply mode", answer("open", BOARD), "?replyto=102"],
    ["the redirect's notice", answer("open", BOARD), "?commented=published"],
  ])("%s has no violations", async (_name, data, query) => {
    const { dom } = await page(await render(data, query))
    expect(await axe(dom, ".comments")).toEqual([])
  }, 30_000)
})
