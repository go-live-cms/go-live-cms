import type { APIRoute } from "astro"
import { linkEndpoint } from "../../../lib/commentData"

export const prerender = false

/**
 * POST /gl-comments/data/unsubscribe (#529, docs/design/reader-comments.md 13.2, 8.2): "Your
 * comments"' **Stop all mail**, `{token}`: every reply subscription of the link's address. 204,
 * or 400 `invalid_token`.
 */
export const POST: APIRoute = (context) => linkEndpoint(context, "data/unsubscribe", "The site couldn't stop your emails just now. Try again in a moment.")
