/**
 * The post route's read of a post's comments (#525, docs/design/reader-comments.md 11.1): the
 * `comments` layout prop. It reads the cached thread answer of #523 only when there is something
 * to show, and never fails the page: a read that fails is logged `comments_fetch_failed` and the
 * post renders without the section.
 *
 * - `discussion` off, or absent (an older API): no read, null.
 * - Closed with no comments: nothing renders, no read.
 * - Open with none: the empty answer, no read ("No comments yet." and the form).
 * - `?thread=<root id>`: that thread alone (6.2's "Show more replies"); `?comments=N`: page N.
 *   A thread or page that isn't there (a stale link) falls back to page 1.
 */
import { getPublicCommentThread, getPublicPostComments, type PublicDiscussion } from "./api"
import { discussionState } from "./discussion"
import { log } from "./log"
import { COMMENT_THREAD_PARAM, COMMENTS_PAGE_PARAM, positiveParam, type PostCommentsData } from "./postComments"

export async function loadPostComments(postId: number, discussion: PublicDiscussion | null | undefined, url: URL, now = new Date()): Promise<PostCommentsData | null> {
  if (!discussion || discussion.state === "off") return null
  if (discussion.count <= 0 && discussionState(discussion, now) === "closed") return null
  const thread = positiveParam(url, COMMENT_THREAD_PARAM)
  const page = positiveParam(url, COMMENTS_PAGE_PARAM) ?? 1
  if (discussion.count <= 0) return { discussion, threads: [], pagination: null }
  try {
    if (thread !== null) {
      const one = await getPublicCommentThread(postId, thread)
      if (one) return { discussion: one.discussion, threads: [one.thread], pagination: null, thread }
    }
    const answer = (await getPublicPostComments(postId, thread === null ? page : 1)) ?? (page > 1 && thread === null ? await getPublicPostComments(postId, 1) : null)
    return answer ? { discussion: answer.discussion, threads: answer.threads, pagination: answer.pagination ?? null } : null
  } catch (error) {
    log.warn("comments_fetch_failed", { post_id: postId, error })
    return null
  }
}
