/**
 * Category URLs (#331): with Settings › General's "By category" structure, a post of
 * type "post" lives at /{category-slug}/{post-slug} (postPath in seo.ts, the API's
 * postHref). Those URLs reach [post_type]/[id].astro like every /{x}/{y}; a public post
 * type or a public taxonomy named {x} keeps its URLs, and only then does the route ask
 * here.
 *
 * Post slugs are unique, so {y} alone finds the post. When {x} isn't its category (the
 * category was renamed or changed, the site switched structures, an old link) the route
 * answers 301 to the post's URL, so category changes need no redirect rows. Tested in
 * categoryUrls.test.ts.
 */
import { getPublicPost, type PublicPost } from "./api"
import { postPath, type UrlStructure } from "./seo"

// normalizePostSlug's output (api/posts_utils.go).
const POST_SLUG = /^[\p{L}\p{N}\p{M}]+(?:-[\p{L}\p{N}\p{M}]+)*$/u

export type CategoryRoute =
  | { kind: "post"; published: PublicPost }
  | { kind: "redirect"; location: string }
  | { kind: "none" }

export async function resolveCategoryRoute(
  segment: string,
  slug: string,
  structure: UrlStructure,
  getPost: (slug: string) => Promise<PublicPost | null> = getPublicPost,
): Promise<CategoryRoute> {
  // An id is only ever /{type}/{id}; a slug is never all digits (the API's rule). Post
  // slugs are letters, digits and single hyphens, so a probe like /wp/login.php costs
  // no API call (they share the API's per-IP limit with page renders, #190).
  if (!slug || /^\d+$/.test(slug) || !POST_SLUG.test(slug)) return { kind: "none" }
  const published = await getPost(slug)
  const post = published?.post
  if (!post || post.post_status !== "published" || post.post_type !== "post" || post.slug !== slug) return { kind: "none" }
  const path = postPath(post, structure)
  if (path === `/${encodeURIComponent(segment)}/${encodeURIComponent(slug)}`) {
    // The post's own URL: its category's, or (the type's name) the route's own case.
    return segment === post.post_type ? { kind: "none" } : { kind: "post", published }
  }
  return { kind: "redirect", location: path }
}
