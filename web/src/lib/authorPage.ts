/**
 * Public author pages (#350): /author/{username}, the post's "Written by" cards and the
 * sitemap's author URLs. The data comes from the API's /public/authors routes, which
 * return only AuthorProfile (no email, role or id) and 404 anyone not credited on a
 * published post. Tested in authorPage.test.ts.
 */
import type { AuthorProfile, Post } from "@gl-admin/lib/api/types"
import { SERVER_MEDIA_URL } from "@gl-admin/lib/server-api-url"
import { pageLinks, toListedPosts, type PostListData } from "./postList"
import { authorPath, normalizeUrlStructure } from "./seo"
import { getSiteSettings } from "./siteSettings"

export { authorPath }

export interface AuthorPageData {
  author: AuthorProfile
  postCount: number
  list: PostListData
}


// Like siteSettings: an unreachable API fails the call after a moment instead of
// hanging the page (the post route then renders without the cards).
const PUBLIC_API_TIMEOUT_MS = 5000

// GET {API}/public{path}: the JSON body, or null for a 404. Anything else throws.
async function getPublic<T>(path: string): Promise<T | null> {
  const response = await fetch(`${SERVER_MEDIA_URL}/public${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(PUBLIC_API_TIMEOUT_MS),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GET /public${path}: HTTP ${response.status}`)
  return (await response.json()) as T
}

// One page of an author's posts, with the author: null when they have no page.
export async function getAuthorPosts(
  username: string,
  limit: number,
  offset: number,
): Promise<{ author: AuthorProfile; posts: Post[]; meta: { total: number } } | null> {
  return getPublic(`/authors/${encodeURIComponent(username)}/posts?limit=${limit}&offset=${offset}`)
}

// The "Written by" cards; [] for a post the public site doesn't serve.
export async function getPostAuthors(postId: number | string): Promise<AuthorProfile[]> {
  const body = await getPublic<{ authors?: AuthorProfile[] }>(`/posts/${encodeURIComponent(String(postId))}/authors`)
  return body?.authors ?? []
}

// Every author with a page, for the sitemap, one request per 1000.
export async function getPublicAuthors(): Promise<{ username: string; last_modified: string }[]> {
  const all: { username: string; last_modified: string }[] = []
  const limit = 1000
  for (let offset = 0; ; offset += limit) {
    const body = await getPublic<{ authors?: { username: string; last_modified: string }[] }>(`/authors?limit=${limit}&offset=${offset}`)
    const page = body?.authors ?? []
    all.push(...page)
    if (page.length < limit) return all
  }
}

// The author page's data, or null when the username has no page (unknown, or not
// credited on anything published: the API answers both the same). The posts route
// carries the author and the total, so this is one API call after the settings.
export async function loadAuthorPage(username: string, page: number, siteUrl: string): Promise<AuthorPageData | null> {
  const site = await getSiteSettings()
  const perPage = site.postsPerPage
  const result = await getAuthorPosts(username, perPage, (page - 1) * perPage)
  if (!result) return null
  const structure = normalizeUrlStructure(site.urlStructure)
  const posts = await toListedPosts(result.posts ?? [], "post", structure, siteUrl)
  const total = result.meta?.total ?? posts.length
  return {
    author: result.author,
    postCount: total,
    list: { posts, total, page, links: pageLinks(authorPath(username), page, perPage, total), siteTitle: site.title },
  }
}
