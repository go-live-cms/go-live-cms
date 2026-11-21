import type { APIRoute } from "astro"
import { linkEndpoint } from "../../lib/commentData"

export const prerender = false

/**
 * POST /gl-comments/data (#529, docs/design/reader-comments.md 13.2): `{token}` from the
 * "Your comments" link's fragment. The API answers the reader's own file (their address and
 * every comment of theirs), which the page lists and Download my data saves; reading doesn't
 * spend the link. 400 `invalid_token` for a link that doesn't work any more.
 */
export const POST: APIRoute = (context) => linkEndpoint(context, "data", "The site couldn't read your comments just now. Try again in a moment.")
