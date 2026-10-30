/**
 * Data for the public post lists (#345): the front page and /{post_type}, in numbered
 * pages of posts_per_page (#349; URLs and the pager window in pagination.ts). Tested
 * in postList.test.ts.
 */
import type { Post } from "@gl-admin/lib/api/types"
import { getFeaturedImageUrl, getPublicPostsPage, type PublicPostPage } from "./api"
import { pageLinks, pagePath, type PageLinks } from "./pagination"
import { normalizeUrlStructure, postPath, publicImageUrl, type SeoMeta, type UrlStructure } from "./seo"
import { getSiteSettings } from "./siteSettings"

export type { PageLinks } from "./pagination"

export interface ListedPost {
  post: Post
  href: string
  // The featured image on this site's origin, or null.
  image: string | null
}

export interface PostListData {
  posts: ListedPost[]
  total: number
  page: number
  totalPages: number
  // Page 1's URL; page N is pagePath(basePath, N).
  basePath: string
  links: PageLinks
  siteTitle: string
  // "" = none (#330).
  siteTagline?: string
}

// The featured image URL a with_meta list row carries (post meta _thumbnail_url): the URL,
// null for none, or undefined when the stored value is not a URL (a pre-#201 filesystem
// path, which only the API can map to /uploads).
export function listedThumbnail(post: Post): string | null | undefined {
  const value = (post as Post & { meta?: Record<string, unknown> }).meta?._thumbnail_url
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string") return undefined
  return /^https?:\/\//i.test(value) || value.startsWith("/uploads/") ? value : undefined
}

// The list page's canonical URL and its rel="prev"/"next" neighbours, for SeoHead.
export function listSeo(list: Pick<PostListData, "page" | "basePath" | "links">): SeoMeta {
  return { canonical: pagePath(list.basePath, list.page), prev: list.links.newer, next: list.links.older }
}

const NO_POSTS: PublicPostPage = { posts: [], pagination: { page: 1, per_page: 0, total: 0, total_pages: 0 } }

// Page `page` of a post type's published posts, or null when there is no such page
// (past the end, or a type the API doesn't list publicly): the route answers 404.
// Page 1 always exists; it may be empty (the front page with "post" switched off).
export async function loadPostList(
  postType: string,
  page: number,
  basePath: string,
  siteUrl: string,
  locals?: App.Locals,
): Promise<PostListData | null> {
  const [site, found] = await Promise.all([getSiteSettings(locals), getPublicPostsPage(postType, page)])
  const result = found ?? (page === 1 ? NO_POSTS : null)
  if (!result) return null
  const structure = normalizeUrlStructure(site.urlStructure)
  const posts = await toListedPosts(result.posts, postType, structure, siteUrl)
  const { total, total_pages: totalPages } = result.pagination
  return {
    posts,
    total,
    page,
    totalPages,
    basePath,
    links: pageLinks(basePath, page, totalPages),
    siteTitle: site.title,
    siteTagline: site.tagline,
  }
}

// with_meta list rows as list items; the author page's list (#350) uses it too.
// fallbackType names the type of rows that don't say.
export function toListedPosts(data: Post[], fallbackType: string, structure: UrlStructure, siteUrl: string): Promise<ListedPost[]> {
  return Promise.all(data.map((post) => toListedPost(post, fallbackType, structure, siteUrl)))
}

// One with_meta row (a list row, or a related/adjacent post, #351) with its link and image.
export async function toListedPost(post: Post, postType: string, structure: UrlStructure, siteUrl: string): Promise<ListedPost> {
  // with_meta rows carry the featured image URL; only rows whose stored value is an
  // old filesystem path (before #201) need the featured-image endpoint to map it.
  const stored = listedThumbnail(post)
  const url = stored !== undefined ? stored : await getFeaturedImageUrl(post.id).catch(() => null)
  return {
    post,
    href: postPath({ ...post, post_type: post.post_type || postType }, structure),
    image: publicImageUrl(siteUrl, url) ?? null,
  }
}
