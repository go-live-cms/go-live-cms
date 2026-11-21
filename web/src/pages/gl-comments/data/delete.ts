import type { APIRoute } from "astro"
import { commentIdField, linkEndpoint } from "../../../lib/commentData"

export const prerender = false

/**
 * POST /gl-comments/data/delete (#529, docs/design/reader-comments.md 13.2): `{token,
 * comment_id}` is the page's Delete on one comment, `{token}` alone **Delete everything** (the
 * erasure, asked first on the page). 204, or the API's 400 `invalid_token` / 404
 * `comment_not_found`.
 */
export const POST: APIRoute = (context) =>
  linkEndpoint(context, "data/delete", "The site couldn't delete that just now. Try again in a moment.", (fields) => {
    if (!fields.has("comment_id")) return {}
    const id = commentIdField(fields.get("comment_id"))
    return id === null ? null : { comment_id: id }
  })
