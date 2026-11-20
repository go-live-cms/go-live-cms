/**
 * The comment form's names (#524, #525): the fields the comments section renders and the
 * `/gl-comments/posts/:id` endpoint reads (`commentWrites.ts`), and the `?commented=` notice
 * its redirect adds. Import-free, so the section's markup (which the comments site block,
 * #500, renders inside `BlockRenderer`) never pulls in the endpoint's server code.
 */
export const COMMENT_FORM_FIELDS = {
  body: "comment",
  name: "name",
  email: "email",
  notifyReplies: "notify_replies",
  // The honeypot (5.2): hidden, labelled "Leave this empty". Anything in it is spam.
  website: "website",
  parentId: "parent_id",
  // The page the form is on (the post, or its page N of comments): where to go back.
  returnTo: "return_to",
} as const

/** The notice a post page shows after a redirect (`?commented=`), never cached (httpCache.ts). */
export const COMMENTED_PARAM = "commented"

/**
 * The API's comment refusals by code, in the reader's words (the form states board): the
 * refusal page and the confirm page's `?error=` say them, and `public/gl-comments.js` keeps a
 * copy (`glComments.test.ts` compares the two).
 */
export const COMMENT_CODE_REASONS: Readonly<Record<string, string>> = {
  comments_closed: "Comments on this post are closed.",
  comments_off: "Comments are off for this post.",
  not_found: "This post isn't available.",
  parent_not_found: "The comment you replied to isn't available any more. Post yours as a new comment.",
  comments_busy: "Too many comments are waiting for review on this post. Try again later.",
  invalid_token: "This link has been used or has expired.",
}
