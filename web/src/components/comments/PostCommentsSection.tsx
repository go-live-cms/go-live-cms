/**
 * The comments section's markup (#525, docs/design/reader-comments.md 11.1, 11.2, 11.5): core's,
 * the same for a code layout (`PostComments.astro`) and the comments site block (#500), and styled
 * by the theme through the classes `src/components/blocks/README.md` lists. It draws a
 * `CommentsView` (`src/lib/postComments.ts`) and reads nothing itself.
 *
 * **A comment's text is text.** Every name, body and link is a React text child or an attribute
 * value, so it is escaped; nothing here inserts raw HTML (6.3: a comment never reaches the raw
 * HTML directives; PostComments.astro.test.ts checks the sources), and the links in a comment
 * carry `rel="nofollow ugc noopener"` (5.4).
 *
 * Works without scripts: the form posts to `/gl-comments/posts/:id` (9.4), Reply is a link to
 * `?replyto=<id>#comment-form`. `gl-comments.js` (11.4) only enhances it: `data-gl-comments`
 * marks the form it takes over, and the status region is in the page, empty, from the start
 * (#477's rule), so what it says there is spoken.
 */
import { Fragment } from "react"
import {
  COMMENT_FORM_FIELDS,
  COMMENT_FORM_ID,
  COMMENT_NOTICES,
  COMMENTS_ID,
  formatCount,
  type CommentsFormView,
  type CommentView,
  type CommentsView,
  type PagerView,
} from "@/lib/postComments"
import type { ReaderCommentRun } from "@/lib/discussion"

/** `rel` of a link in a reader's comment (5.4): no endorsement, user content, no opener. */
export const COMMENT_LINK_REL = "nofollow ugc noopener"

function Runs({ runs }: { runs: ReaderCommentRun[] }) {
  return (
    <>
      {runs.map((run, i) =>
        run.href ? (
          <a key={i} href={run.href} rel={COMMENT_LINK_REL}>
            {run.text}
          </a>
        ) : (
          <Fragment key={i}>{run.text}</Fragment>
        ),
      )}
    </>
  )
}

function CommentText({ comment }: { comment: CommentView }) {
  return (
    <div className="comment-text">
      {comment.paragraphs.map((paragraph, i) => (
        <p key={i}>
          {paragraph.lines.map((line, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              <Runs runs={line} />
            </Fragment>
          ))}
        </p>
      ))}
    </div>
  )
}

function Avatar({ comment }: { comment: CommentView }) {
  if (!comment.avatar) return <span className="avatar" aria-hidden="true"></span>
  if ("src" in comment.avatar) {
    return (
      <span className="avatar" aria-hidden="true">
        <img src={comment.avatar.src} alt="" width={40} height={40} loading="lazy" decoding="async" />
      </span>
    )
  }
  return (
    <span className="avatar" aria-hidden="true" style={{ background: comment.avatar.color }}>
      {comment.avatar.initial}
    </span>
  )
}

/** One comment (11.5): an article named by its author, with its date as a `<time>` linking to it. */
export function CommentArticle({ comment }: { comment: CommentView }) {
  if (comment.removed) {
    return (
      <article className="comment comment-removed" id={comment.anchor} aria-label="Removed comment">
        <span className="avatar" aria-hidden="true"></span>
        <div className="comment-body">
          <div className="comment-text">
            <p>This comment was removed</p>
          </div>
        </div>
      </article>
    )
  }
  return (
    <article className="comment" id={comment.anchor} aria-labelledby={comment.nameId}>
      <Avatar comment={comment} />
      <div className="comment-body">
        <header className="comment-meta">
          <b className="comment-author" id={comment.nameId}>
            {comment.name}
          </b>
          {comment.badge && <span className="comment-badge">{comment.badge}</span>}
          <a href={`#${comment.anchor}`}>
            <time dateTime={comment.datetime}>{comment.date}</time>
          </a>
          {comment.edited && <span className="comment-edited">Edited</span>}
        </header>
        {comment.replyingTo && (
          <span className="comment-replyto">
            {"Replying to "}
            <a href={`#${comment.replyingTo.anchor}`}>{comment.replyingTo.name}</a>
          </span>
        )}
        <CommentText comment={comment} />
        {comment.replyHref && (
          <div className="comment-actions">
            <a href={comment.replyHref} className="comment-reply" data-reply-to={comment.id} aria-label={`Reply to ${comment.name}`}>
              Reply
            </a>
          </div>
        )}
      </div>
    </article>
  )
}

function Pager({ pager }: { pager: PagerView }) {
  return (
    <nav className="pagination comments-pagination" aria-label={pager.label}>
      {pager.previous ? (
        <a href={pager.previous} className="page-link" rel="prev">
          <span aria-hidden="true">←</span> Previous comments
        </a>
      ) : (
        <span className="page-link is-disabled" aria-hidden="true">
          ← Previous comments
        </span>
      )}
      {pager.slots.map(({ slot, href, current }, i) =>
        slot === "gap" || !href ? (
          <span key={`gap-${i}`} className="page-link page-num" aria-hidden="true">
            …
          </span>
        ) : (
          <a key={slot} href={href} className="page-link page-num" aria-label={`Comments page ${slot}`} aria-current={current ? "page" : undefined}>
            {slot}
          </a>
        ),
      )}
      <span className="page-status">{`Page ${pager.page} of ${pager.totalPages}`}</span>
      {pager.next ? (
        <a href={pager.next} className="page-link" rel="next">
          Next comments <span aria-hidden="true">→</span>
        </a>
      ) : (
        <span className="page-link is-disabled" aria-hidden="true">
          Next comments →
        </span>
      )}
    </nav>
  )
}

const ICON_OK = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5"></path>
  </svg>
)

function CommentForm({ form }: { form: CommentsFormView }) {
  const notice = form.notice ? COMMENT_NOTICES[form.notice] : null
  const f = COMMENT_FORM_FIELDS
  return (
    <form
      className="comment-form"
      id={COMMENT_FORM_ID}
      method="post"
      action={form.action}
      aria-labelledby="comment-form-title"
      data-gl-comments=""
      data-closes-at={form.closesAt ?? undefined}
    >
      <h3 id="comment-form-title">{form.title}</h3>
      {form.replyingTo && (
        <p className="comment-form-replying">
          <span>
            {"Replying to "}
            <a href={`#${form.replyingTo.anchor}`}>{form.replyingTo.name}</a>
          </span>
          <a href={form.replyingTo.cancelHref} data-reply-cancel="">
            Cancel
          </a>
        </p>
      )}
      <div role="status" className="comment-status">
        {notice && (
          <div className="comment-notice is-success">
            {ICON_OK}
            <div>
              <b>{notice.title}</b>
              <p>{notice.body}</p>
            </div>
          </div>
        )}
      </div>
      <div className="comment-field">
        <label htmlFor="comment-body">Comment</label>
        <textarea id="comment-body" name={f.body} className="input" required aria-describedby="comment-body-count" defaultValue=""></textarea>
        <span className="comment-count" id="comment-body-count" data-max={form.bodyMax}>
          {`Up to ${formatCount(form.bodyMax)} characters`}
        </span>
      </div>
      <div className="comment-fields">
        <div className="comment-field">
          <label htmlFor="comment-name">Name</label>
          <input id="comment-name" name={f.name} className="input" autoComplete="name" required />
        </div>
        <div className="comment-field">
          <label htmlFor="comment-email">
            Email <span className="hint">· never shown</span>
          </label>
          <input id="comment-email" name={f.email} type="email" className="input" autoComplete="email" required />
        </div>
      </div>
      <label className="comment-check">
        <input type="checkbox" name={f.notifyReplies} value="1" />
        Email me replies
      </label>
      <div className="comment-hp" aria-hidden="true">
        <label>
          Leave this empty <input name={f.website} tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      {form.replyingTo && <input type="hidden" name={f.parentId} value={form.replyingTo.id} />}
      <input type="hidden" name={f.returnTo} value={form.returnTo} />
      <div className="comment-submit">
        <button type="submit" className="btn btn-primary">
          Post comment
        </button>
      </div>
      <p className="comment-privacy">
        {/* One text node before the links: React separates adjacent ones with a comment. */}
        {form.privacyHref || form.yourCommentsHref ? `${form.notice7_5} ` : form.notice7_5}
        {form.privacyHref && <a href={form.privacyHref}>Privacy</a>}
        {form.privacyHref && form.yourCommentsHref && " · "}
        {form.yourCommentsHref && <a href={form.yourCommentsHref}>Your comments</a>}
      </p>
    </form>
  )
}

export interface PostCommentsSectionProps {
  view: CommentsView
  /** Extra classes on the section (a layout's `measure`). */
  className?: string
  /** `/gl-comments.js` after the section, when it has a form (a code layout: the page has no other). */
  script?: string | null
}

/** The section (11.2): the heading with the count, the threads, pagination, "closed", the form. */
export function PostCommentsSection({ view, className, script }: PostCommentsSectionProps) {
  const empty = view.threads.length === 0
  return (
    <>
      <section className={["comments", className].filter(Boolean).join(" ")} id={COMMENTS_ID} aria-labelledby="comments-title">
        <h2 className="comments-title" id="comments-title">
          {view.count > 0 ? `${view.title} ` : view.title}
          {view.count > 0 && <span className="comments-count">{view.count}</span>}
        </h2>
        {empty && <p className="comments-empty">No comments yet.</p>}
        {view.allCommentsHref && (
          <p className="comments-thread-back">
            <a href={view.allCommentsHref}>All comments</a>
          </p>
        )}
        {!empty && (
          <ol className="comment-list">
            {view.threads.map((thread) => (
              <li key={thread.comment.id}>
                <CommentArticle comment={thread.comment} />
                {thread.replies.length > 0 && (
                  <ol className="comment-replies">
                    {thread.replies.map((reply) => (
                      <li key={reply.id}>
                        <CommentArticle comment={reply} />
                      </li>
                    ))}
                  </ol>
                )}
                {thread.more && (
                  <a href={thread.more.href} className="comment-more">
                    {`Show ${thread.more.count} more ${thread.more.count === 1 ? "reply" : "replies"}`}
                  </a>
                )}
              </li>
            ))}
          </ol>
        )}
        {view.pager && <Pager pager={view.pager} />}
        {view.closed && <p className="comments-closed">Comments are closed.</p>}
        {view.form && <CommentForm form={view.form} />}
      </section>
      {view.form && script && <script src={script} defer></script>}
    </>
  )
}
