/**
 * The comments section's rules (#525, docs/design/reader-comments.md 11.1 to 11.3): what
 * `PostComments` shows for a thread answer, as plain data the markup
 * (`src/components/comments/PostCommentsSection.tsx`) renders. Pure and import-light, so the
 * code layouts' `PostComments.astro` and the comments site block (#500) build the same view
 * from the same answer. Tested in `postComments.test.ts`.
 *
 * Nothing here depends on who reads the page (design section 10): the view comes from the
 * cached thread answer, the clock (12.4's `closes_at`), the URL (`?comments=N`,
 * `?thread=<id>`, `?replyto=<id>`, and the `?commented=` notice of 9.4's redirect, a URL
 * that is never cached) and the site's settings.
 */
import { discussionState, READER_COMMENT_LIMITS, readerCommentRuns, type ReaderCommentRun } from "./discussion"
import type { PublicDiscussion, PublicReaderComment, PublicReaderCommentThread } from "./api"
import type { Pagination } from "./pagination"
import { pageWindow, type PageSlot } from "./pagination"
import { avatarColor, initial } from "./bylines"
import { formatSiteDate, type DateSettings } from "./siteDates"
import { safeAvatarSrc } from "@gl-admin/lib/presence"
import { COMMENTED_PARAM, COMMENT_FORM_FIELDS } from "./commentFormFields"

/** The thread answer a layout gets as its `comments` prop (themes/README.md, Layout Props). */
export interface PostCommentsData {
  discussion: PublicDiscussion
  threads: PublicReaderCommentThread[]
  /** Null for one thread alone (`?thread=`), or when the post has no comments to page. */
  pagination: Pagination | null
  /** `?thread=<root id>`: one thread with all its replies (6.2's "Show more replies"). */
  thread?: number | null
}

/** The section's title when nothing names it (the comments block's `title` can, #500). */
export const COMMENTS_TITLE = "Comments"
/** The section's, the form's and a comment's anchors (11.3). */
export const COMMENTS_ID = "comments"
export const COMMENT_FORM_ID = "comment-form"
export const commentAnchor = (id: number) => `comment-${id}`
/** The query parameters of 11.3 and 11.2. */
export const COMMENTS_PAGE_PARAM = "comments"
export const COMMENT_THREAD_PARAM = "thread"
export const REPLY_TO_PARAM = "replyto"
/** gl-comments.js (11.4): plain and unbundled in public/, like gl-embeds.js. */
export const COMMENTS_SCRIPT_SRC = "/gl-comments.js"
/** The privacy notice's default text (7.5), when `comments_notice` is empty. */
export const DEFAULT_COMMENTS_NOTICE =
  "Your email is never shown. We use it to confirm your comment and, if you ask, to tell you about replies. Confirming keeps a cookie on this browser so you won’t be asked again."

/** Whether the reader pages that need #528 and #529's routes are served yet (11.6). */
export const READER_PAGES_READY = {
  // #528: POST /gl-comments/unsubscribe and the RFC 8058 /gl-comments/unsubscribe/:token.
  unsubscribe: true,
  // #529 adds /gl-comments/data-request, /data and /data/delete and sets this true.
  yourData: false,
} as const
export const CONFIRM_PATH = "/comments/confirm"
export const UNSUBSCRIBE_PATH = "/comments/unsubscribe"
export const YOUR_DATA_PATH = "/comments/your-data"

export type CommentNotice = "confirm" | "pending" | "published"

/** The site settings the section reads (Settings › Discussion's public fields, 12.1). */
export interface CommentsSettings {
  threading: "replies" | "flat"
  notice: string
  privacyHref: string | null
}

/** The settings when the site's can't be read: threaded, the default notice, no privacy page. */
export const DEFAULT_COMMENTS_SETTINGS: CommentsSettings = { threading: "replies", notice: "", privacyHref: null }

export interface CommentsRequest {
  /** The post page's path, without a query (`/post/hello-world`). */
  path: string
  url: URL
  now: Date
}

export interface CommentRunsParagraph {
  /** Each line of the paragraph (a `<br>` between them), as text and link runs. */
  lines: ReaderCommentRun[][]
}

export interface CommentView {
  id: number
  anchor: string
  nameId: string
  removed: boolean
  name: string
  badge: "Author" | "Staff" | null
  avatar: { src: string } | { initial: string; color: string } | null
  datetime: string
  date: string
  edited: boolean
  paragraphs: CommentRunsParagraph[]
  replyingTo: { name: string; anchor: string } | null
  /** The Reply link (11.2), or null when replies can't be written here. */
  replyHref: string | null
}

export interface ThreadView {
  comment: CommentView
  replies: CommentView[]
  /** "Show N more replies" (6.2): the thread on its own page. */
  more: { count: number; href: string } | null
}

export interface PagerView {
  label: string
  previous: string | null
  next: string | null
  slots: { slot: PageSlot; href: string | null; current: boolean }[]
  page: number
  totalPages: number
}

export interface CommentsFormView {
  action: string
  title: string
  replyingTo: { id: number; name: string; anchor: string; cancelHref: string } | null
  returnTo: string
  notice: CommentNotice | null
  closesAt: string | null
  notice7_5: string
  privacyHref: string | null
  yourCommentsHref: string | null
  bodyMax: number
}

export interface CommentsView {
  title: string
  count: number
  closed: boolean
  threads: ThreadView[]
  pager: PagerView | null
  /** On a thread's own page: the way back to every comment. */
  allCommentsHref: string | null
  form: CommentsFormView | null
}

const BADGES = { author: "Author", staff: "Staff" } as const

/** The section's state (11.2): "open" and "closed" render; "none" renders nothing at all. */
export function commentsSectionState(data: PostCommentsData | null | undefined, now: Date): "open" | "closed" | "none" {
  if (!data?.discussion) return "none"
  const state = discussionState(data.discussion, now)
  if (state === "off") return "none"
  if (state === "closed" && data.threads.length === 0) return "none"
  return state
}

/** A comment's text as paragraphs (blank lines) of lines (single newlines) of text and links (6.3). */
export function commentParagraphs(body: string): CommentRunsParagraph[] {
  return body
    .split(/\n{2,}/)
    .map((block) => block.replace(/^\n+|\n+$/g, ""))
    .filter((block) => block !== "")
    .map((block) => ({ lines: block.split("\n").map((line) => readerCommentRuns(line)) }))
}

/** `?name=value` on the page's path, keeping only the comments' own parameters given. */
function pageHref(path: string, params: Record<string, string | number | null | undefined>, hash: string): string {
  const query = Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    .join("&")
  return `${path}${query ? `?${query}` : ""}#${hash}`
}

/** A positive integer parameter (a page or a comment id, at most 15 digits), else null. */
export function positiveParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name)
  if (raw === null || !/^[1-9][0-9]{0,14}$/.test(raw)) return null
  return Number(raw)
}

/** The `?commented=` notice of 9.4's redirect. */
export function commentNotice(url: URL): CommentNotice | null {
  const value = url.searchParams.get(COMMENTED_PARAM)
  return value === "confirm" || value === "pending" || value === "published" ? value : null
}

function commentView(
  comment: PublicReaderComment,
  dates: DateSettings,
  replyHref: ((id: number) => string) | null,
  shown: ReadonlyMap<number, PublicReaderComment>,
): CommentView {
  const anchor = commentAnchor(comment.id)
  const src = comment.removed ? null : safeAvatarSrc(comment.avatar)
  const answered = comment.parent_id !== null && comment.parent_id !== comment.root_id ? shown.get(comment.parent_id) : undefined
  return {
    id: comment.id,
    anchor,
    nameId: `${anchor}-name`,
    removed: comment.removed,
    name: comment.removed ? "" : comment.name,
    badge: comment.removed || !comment.badge ? null : (BADGES[comment.badge] ?? null),
    avatar: comment.removed ? null : src ? { src } : { initial: initial(comment.name), color: avatarColor(comment.name) },
    datetime: comment.created_at,
    date: formatSiteDate(comment.created_at, dates),
    edited: !comment.removed && comment.edited,
    paragraphs: comment.removed ? [] : commentParagraphs(comment.body),
    replyingTo:
      !comment.removed && comment.replying_to
        ? { name: comment.replying_to, anchor: commentAnchor(answered && !answered.removed ? answered.id : (comment.parent_id ?? comment.id)) }
        : null,
    replyHref: comment.removed || !replyHref ? null : replyHref(comment.id),
  }
}

/**
 * The section as `PostCommentsSection` draws it (11.2), or null when nothing renders (off, a
 * closed post with no comments, no answer). `postId` is the form's target.
 */
export function commentsView(
  data: PostCommentsData | null | undefined,
  postId: number,
  request: CommentsRequest,
  settings: CommentsSettings,
  dates: DateSettings,
  title = COMMENTS_TITLE,
): CommentsView | null {
  const state = commentsSectionState(data, request.now)
  if (!data || state === "none") return null
  const open = state === "open"
  const threaded = settings.threading !== "flat"
  const page = data.pagination?.page && data.pagination.page > 1 ? data.pagination.page : null
  const thread = data.thread ?? null
  // The page's own parameters: page N of the threads, or one thread alone.
  const own = thread ? { [COMMENT_THREAD_PARAM]: thread } : { [COMMENTS_PAGE_PARAM]: page }
  const replyHref = open && threaded ? (id: number) => pageHref(request.path, { ...own, [REPLY_TO_PARAM]: id }, COMMENT_FORM_ID) : null

  const shown = new Map<number, PublicReaderComment>()
  for (const t of data.threads) {
    shown.set(t.comment.id, t.comment)
    for (const r of t.replies) shown.set(r.id, r)
  }
  const threads: ThreadView[] = data.threads.map((t) => ({
    comment: commentView(t.comment, dates, replyHref, shown),
    replies: t.replies.map((r) => commentView(r, dates, replyHref, shown)),
    more:
      !thread && t.reply_count > t.replies.length
        ? { count: t.reply_count - t.replies.length, href: pageHref(request.path, { [COMMENT_THREAD_PARAM]: t.comment.id }, commentAnchor(t.comment.id)) }
        : null,
  }))

  const pagination = data.pagination
  let pager: PagerView | null = null
  if (!thread && pagination && pagination.total_pages > 1) {
    const at = (n: number) => pageHref(request.path, { [COMMENTS_PAGE_PARAM]: n > 1 ? n : null }, COMMENTS_ID)
    pager = {
      label: "Comment pages",
      previous: pagination.page > 1 ? at(pagination.page - 1) : null,
      next: pagination.page < pagination.total_pages ? at(pagination.page + 1) : null,
      slots: pageWindow(pagination.page, pagination.total_pages).map((slot) => ({
        slot,
        href: slot === "gap" ? null : at(slot),
        current: slot === pagination.page,
      })),
      page: pagination.page,
      totalPages: pagination.total_pages,
    }
  }

  let form: CommentsFormView | null = null
  if (open) {
    const replyId = threaded ? positiveParam(request.url, REPLY_TO_PARAM) : null
    const target = replyId !== null ? shown.get(replyId) : undefined
    const replyingTo =
      target && !target.removed
        ? { id: target.id, name: target.name, anchor: commentAnchor(target.id), cancelHref: pageHref(request.path, own, COMMENT_FORM_ID) }
        : null
    const returnTo = pageHref(request.path, own, "").replace(/#$/, "")
    form = {
      action: `/gl-comments/posts/${postId}`,
      title: replyingTo ? `Reply to ${replyingTo.name}` : "Leave a comment",
      replyingTo,
      returnTo,
      notice: commentNotice(request.url),
      closesAt: data.discussion.closes_at,
      notice7_5: settings.notice.trim() || DEFAULT_COMMENTS_NOTICE,
      privacyHref: settings.privacyHref,
      yourCommentsHref: READER_PAGES_READY.yourData ? YOUR_DATA_PATH : null,
      bodyMax: READER_COMMENT_LIMITS.body_max,
    }
  }

  return {
    title: title.trim() || COMMENTS_TITLE,
    count: Math.max(0, data.discussion.count),
    closed: !open,
    threads,
    pager,
    allCommentsHref: thread ? pageHref(request.path, {}, COMMENTS_ID) : null,
    form,
  }
}

/** The form's field names (#524's `COMMENT_FORM_FIELDS`), re-exported for the markup. */
export { COMMENT_FORM_FIELDS }

/** The `?commented=` notices' words (the form states board). */
export const COMMENT_NOTICES: Record<CommentNotice, { title: string; body: string }> = {
  confirm: {
    title: "Check your email to publish your comment",
    body: "We sent a link to the address you gave. Your comment appears once you open it. If nothing arrives in a few minutes, look in your spam folder.",
  },
  pending: { title: "Thanks. Your comment is waiting for review", body: "It shows on the post once a moderator approves it." },
  published: { title: "Your comment is published", body: "It’s at the end of the comments." },
}

/** "4,000": the counter's limit as the form writes it. */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}
