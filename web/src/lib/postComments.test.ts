// The comments section's rules (#525, docs/design/reader-comments.md 11.2, 11.3, 6.3): what
// PostComments shows for each discussion state, a comment's text as paragraphs and links, the
// URLs of Reply, the pager and "Show more replies", reply mode and the redirect's notice.
import { describe, expect, it } from "vitest"
import type { PublicReaderComment, PublicReaderCommentThread } from "./api"
import { readerCommentLinks, readerCommentRuns } from "./discussion"
import type { DateSettings } from "./siteDates"
import {
  commentParagraphs,
  commentsSectionState,
  commentsView,
  DEFAULT_COMMENTS_NOTICE,
  READER_PAGES_READY,
  type CommentsSettings,
  type PostCommentsData,
} from "./postComments"

const NOW = new Date("2026-11-20T12:00:00Z")
const DATES = { language: "en-US", timeZone: "UTC", dateFormat: "month_day_year" } as DateSettings
const SETTINGS: CommentsSettings = { threading: "replies", notice: "", privacyHref: null }

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
const thread = (root: PublicReaderComment, replies: PublicReaderComment[] = [], replyCount = replies.length): PublicReaderCommentThread => ({ comment: root, replies, reply_count: replyCount })
const data = (state: "open" | "closed" | "off", threads: PublicReaderCommentThread[], extra: Partial<PostCommentsData> = {}): PostCommentsData => ({
  discussion: { state, closes_at: null, count: threads.reduce((n, t) => n + (t.comment.removed ? 0 : 1) + t.replies.length, 0) },
  threads,
  pagination: { page: 1, per_page: 30, total: threads.length, total_pages: 1 },
  ...extra,
})
const request = (query = "") => ({ path: "/post/hello", url: new URL(`http://site.example/post/hello${query}`), now: NOW })
const view = (d: PostCommentsData | null, query = "", settings = SETTINGS) => commentsView(d, 42, request(query), settings, DATES)

describe("what the section shows (11.2)", () => {
  it("off: nothing at all", () => {
    expect(commentsSectionState(data("off", []), NOW)).toBe("none")
    expect(view(data("off", [thread(comment(1))]))).toBeNull()
  })

  it("closed with no comments: nothing; closed with comments: the threads and no form", () => {
    expect(view(data("closed", []))).toBeNull()
    const v = view(data("closed", [thread(comment(1))]))!
    expect(v.closed).toBe(true)
    expect(v.form).toBeNull()
    expect(v.threads[0].comment.replyHref).toBeNull()
  })

  it("open with none: the form, the count left out", () => {
    const v = view(data("open", [], { pagination: null }))!
    expect(v.threads).toEqual([])
    expect(v.count).toBe(0)
    expect(v.form?.title).toBe("Leave a comment")
  })

  it("open: the title with the count, Reply links, the form posting to the site's endpoint", () => {
    const v = view(data("open", [thread(comment(1), [comment(2, { parent_id: 1, root_id: 1 })])]))!
    expect(v.title).toBe("Comments")
    expect(v.count).toBe(2)
    expect(v.threads[0].comment.replyHref).toBe("/post/hello?replyto=1#comment-form")
    expect(v.form?.action).toBe("/gl-comments/posts/42")
    expect(v.form?.returnTo).toBe("/post/hello")
  })

  it("applies the clock to a cached answer: past closes_at it is closed (12.4)", () => {
    const d = data("open", [thread(comment(1))])
    d.discussion.closes_at = "2026-11-03T00:00:00Z"
    expect(commentsSectionState(d, NOW)).toBe("closed")
    expect(view(d)!.form).toBeNull()
    d.discussion.closes_at = "2026-12-03T00:00:00Z"
    expect(view(d)!.form?.closesAt).toBe("2026-12-03T00:00:00Z")
  })

  it("no answer (the read failed): nothing", () => {
    expect(view(null)).toBeNull()
  })
})

describe("a comment's text (6.3, 5.4)", () => {
  it("paragraphs on blank lines, lines on single newlines", () => {
    expect(commentParagraphs("One\nTwo\n\n\nThree")).toEqual([
      { lines: [[{ text: "One" }], [{ text: "Two" }]] },
      { lines: [[{ text: "Three" }]] },
    ])
  })

  it("links the URLs the API counts, leaving sentence punctuation outside", () => {
    const line = "See https://okafor.example/notes/(draft), and http://a.example."
    expect(readerCommentRuns(line)).toEqual([
      { text: "See " },
      { text: "https://okafor.example/notes/(draft)", href: "https://okafor.example/notes/(draft)" },
      { text: ", and " },
      { text: "http://a.example", href: "http://a.example" },
      { text: "." },
    ])
    expect(readerCommentRuns(line).filter((r) => r.href).map((r) => r.href)).toEqual(readerCommentLinks(line))
  })

  it("leaves markup as text and never links other schemes", () => {
    expect(readerCommentRuns('<a href="javascript:alert(1)">x</a> ftp://x.example')).toEqual([{ text: '<a href="javascript:alert(1)">x</a> ftp://x.example' }])
    expect(readerCommentRuns("https://")).toEqual([{ text: "https://" }])
  })
})

describe("comments (11.2, 11.5)", () => {
  it("names, badges, dates in the site's format, avatars", () => {
    const v = view(data("open", [thread(comment(1, { badge: "author", avatar: "/uploads/_avatars/avatar-0123456789abcdef0123456789abcdef.jpg" }), [comment(2, { badge: "staff", parent_id: 1, root_id: 1 })])]))!
    const [root, reply] = [v.threads[0].comment, v.threads[0].replies[0]]
    expect(root).toMatchObject({ anchor: "comment-1", nameId: "comment-1-name", badge: "Author", date: "November 17, 2026", avatar: { src: "/uploads/_avatars/avatar-0123456789abcdef0123456789abcdef.jpg" } })
    expect(reply).toMatchObject({ badge: "Staff", avatar: { initial: "R" } })
  })

  it("never serves an avatar that isn't one of the API's files", () => {
    const v = view(data("open", [thread(comment(1, { avatar: "https://tracker.example/a.png" }))]))!
    expect(v.threads[0].comment.avatar).toEqual({ initial: "R", color: expect.stringMatching(/^#[0-9a-f]{6}$/) })
  })

  it("a removed comment keeps its place and its replies, with no name or Reply", () => {
    const v = view(data("open", [thread(comment(1, { removed: true, name: "", body: "" }), [comment(2, { parent_id: 1, root_id: 1 })])]))!
    expect(v.threads[0].comment).toMatchObject({ removed: true, name: "", replyHref: null, paragraphs: [] })
    expect(v.threads[0].replies[0].replyHref).not.toBeNull()
  })

  it("a reply to a reply says whom it answers, linking to that comment", () => {
    const a = comment(2, { parent_id: 1, root_id: 1, name: "Luan" })
    const b = comment(3, { parent_id: 2, root_id: 1, replying_to: "Luan" })
    const v = view(data("open", [thread(comment(1), [a, b])]))!
    expect(v.threads[0].replies[1].replyingTo).toEqual({ name: "Luan", anchor: "comment-2" })
  })

  it("flat: no Reply links and no reply mode", () => {
    const v = view(data("open", [thread(comment(1))]), "?replyto=1", { ...SETTINGS, threading: "flat" })!
    expect(v.threads[0].comment.replyHref).toBeNull()
    expect(v.form?.replyingTo).toBeNull()
  })
})

describe("URLs (11.3)", () => {
  const many = (page: number, total: number) => data("open", [thread(comment(1))], { pagination: { page, per_page: 30, total: total * 30, total_pages: total } })

  it("page N is ?comments=N#comments, page 1 the post's URL", () => {
    const v = view(many(2, 3), "?comments=2")!
    expect(v.pager).toMatchObject({ label: "Comment pages", previous: "/post/hello#comments", next: "/post/hello?comments=3#comments", page: 2, totalPages: 3 })
    expect(v.pager!.slots.map((s) => [s.slot, s.current])).toEqual([[1, false], [2, true], [3, false]])
    // Reply and the form keep the page.
    expect(v.threads[0].comment.replyHref).toBe("/post/hello?comments=2&replyto=1#comment-form")
    expect(v.form?.returnTo).toBe("/post/hello?comments=2")
  })

  it("no pager for one page", () => {
    expect(view(many(1, 1))!.pager).toBeNull()
  })

  it("a thread over its page's replies links to itself alone; that page links back", () => {
    const replies = [comment(2, { parent_id: 1, root_id: 1 })]
    expect(view(data("open", [thread(comment(1), replies, 112)]))!.threads[0].more).toEqual({ count: 111, href: "/post/hello?thread=1#comment-1" })
    const alone = view(data("open", [thread(comment(1), replies)], { pagination: null, thread: 1 }), "?thread=1")!
    expect(alone.threads[0].more).toBeNull()
    expect(alone.allCommentsHref).toBe("/post/hello#comments")
    expect(alone.threads[0].comment.replyHref).toBe("/post/hello?thread=1&replyto=1#comment-form")
  })
})

describe("the form (11.2, 7.5, 9.4)", () => {
  const d = () => data("open", [thread(comment(1, { name: "Ana" }))])

  it("?replyto=<id>: Reply to Ana, with Cancel back to a new comment", () => {
    expect(view(d(), "?replyto=1")!.form).toMatchObject({
      title: "Reply to Ana",
      replyingTo: { id: 1, name: "Ana", anchor: "comment-1", cancelHref: "/post/hello#comment-form" },
    })
  })

  it("ignores a replyto that isn't a shown comment", () => {
    expect(view(d(), "?replyto=99")!.form?.replyingTo).toBeNull()
    expect(view(d(), "?replyto=abc")!.form?.replyingTo).toBeNull()
  })

  it("?commented= is the redirect's notice; anything else is none", () => {
    expect(view(d(), "?commented=pending")!.form?.notice).toBe("pending")
    expect(view(d(), "?commented=<b>")!.form?.notice).toBeNull()
  })

  it("the privacy notice: core's text unless the site has its own, the privacy page, no Your comments link until #529", () => {
    expect(view(d())!.form).toMatchObject({ notice7_5: DEFAULT_COMMENTS_NOTICE, privacyHref: null })
    expect(view(d(), "", { ...SETTINGS, notice: "We keep comments forever.", privacyHref: "/page/12" })!.form).toMatchObject({ notice7_5: "We keep comments forever.", privacyHref: "/page/12" })
    expect(view(d())!.form?.yourCommentsHref).toBe(READER_PAGES_READY.yourData ? "/comments/your-data" : null)
  })
})
