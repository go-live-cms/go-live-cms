/**
 * Data for the end of a post (#351): older/newer posts, "More to read" and the
 * sidebar's "In <category>". Every part fails soft: a lookup that fails leaves that
 * part out and the post still renders. Tested in relatedPosts.test.ts.
 */
import type { Post, TaxonomyTerm } from "@gl-admin/lib/api/types"
import { getAdjacentPosts, getRelatedPosts } from "./api"
import { toListedPost, type ListedPost } from "./postList"
import { normalizeUrlStructure } from "./seo"
import { getSiteSettings } from "./siteSettings"

export const RELATED_POSTS_LIMIT = 3

export interface CategoryPosts {
  term: TaxonomyTerm
  posts: ListedPost[]
}

export interface PostEndData {
  // The older and newer published post of the same type, null at either end.
  previous: ListedPost | null
  next: ListedPost | null
  related: ListedPost[]
  // Other posts in the post's category, or null when it has none (or none share it).
  inCategory: CategoryPosts | null
}

// The category the sidebar names: the post's first (the API sorts terms by type, then
// name), or undefined.
export function primaryCategory(terms: TaxonomyTerm[] | undefined): TaxonomyTerm | undefined {
  return terms?.find((t) => t.taxonomy_type_name === "category")
}

export interface PostEndSource {
  getAdjacentPosts: typeof getAdjacentPosts
  getRelatedPosts: typeof getRelatedPosts
  getUrlStructure(): Promise<unknown>
  toListedPost: typeof toListedPost
}

const apiSource: PostEndSource = {
  getAdjacentPosts,
  getRelatedPosts,
  getUrlStructure: async () => (await getSiteSettings()).urlStructure,
  toListedPost,
}

export async function loadPostEnd(
  post: Pick<Post, "id" | "post_type">,
  terms: TaxonomyTerm[] | undefined,
  siteUrl: string,
  options: { inCategory?: boolean } = {},
  source: PostEndSource = apiSource,
): Promise<PostEndData> {
  const warn = (part: string) => (error: unknown) => {
    console.warn(`[post end] Could not fetch ${part} for post ${post.id}:`, error)
    return null
  }
  const category = options.inCategory ? primaryCategory(terms) : undefined
  const [structure, adjacent, related, sameCategory] = await Promise.all([
    source.getUrlStructure().catch(() => undefined),
    source.getAdjacentPosts(post.id).catch(warn("older/newer posts")),
    source.getRelatedPosts(post.id, { limit: RELATED_POSTS_LIMIT }).catch(warn("related posts")),
    category
      ? source.getRelatedPosts(post.id, { limit: RELATED_POSTS_LIMIT, taxonomy: "category" }).catch(warn("category posts"))
      : Promise.resolve(null),
  ])
  const urls = normalizeUrlStructure(structure)
  const list = (row: Post) => source.toListedPost(row, post.post_type, urls, siteUrl)
  const [previous, next, relatedList, categoryList] = await Promise.all([
    adjacent?.previous ? list(adjacent.previous) : null,
    adjacent?.next ? list(adjacent.next) : null,
    Promise.all((related ?? []).map(list)),
    Promise.all((sameCategory ?? []).map(list)),
  ])
  return {
    previous,
    next,
    related: relatedList,
    inCategory: category && categoryList.length > 0 ? { term: category, posts: categoryList } : null,
  }
}
