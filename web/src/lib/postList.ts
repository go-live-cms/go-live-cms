/**
 * Data for the public post lists (#345): the front page and /{post_type}. Paging is
 * Newer / Older over posts_per_page; numbered pagination is #349. Tested in
 * postList.test.ts.
 */
import type { Post } from "@gl-admin/lib/api/types"
import { getFeaturedImageUrl, getPostsByType } from "./api"
import { normalizeUrlStructure, postPath, publicImageUrl } from "./seo"
import { getSiteSettings } from "./siteSettings"

export interface ListedPost {
  post: Post
  href: string
  // The featured image on this site's origin, or null.
  image: string | null
}

export interface PageLinks {
  newer?: string
  older?: string
}

export interface PostListData {
  posts: ListedPost[]
  total: number
  page: number
  links: PageLinks
  siteTitle: string
}

// The ?page= query value as a page number (1 for anything missing or invalid).
export function pageNumber(value: string | null | undefined): number {
  const n = Number(value)
  return Number.isInteger(n) && n > 1 ? n : 1
}

export function pageLinks(basePath: string, page: number, perPage: number, total: number): PageLinks {
  const href = (n: number) => (n <= 1 ? basePath : `${basePath}?page=${n}`)
  return {
    newer: page > 1 ? href(Math.min(page - 1, Math.max(1, Math.ceil(total / perPage)))) : undefined,
    older: page * perPage < total ? href(page + 1) : undefined,
  }
}

export async function loadPostList(postType: string, page: number, basePath: string, siteUrl: string): Promise<PostListData> {
  const site = await getSiteSettings()
  const perPage = site.postsPerPage
  const structure = normalizeUrlStructure(site.urlStructure)
  // with_meta: list rows then carry the byline (authors) and the published doc.
  const { data, meta } = await getPostsByType(postType, {
    status: "published",
    sort: "date_desc",
    limit: perPage,
    offset: (page - 1) * perPage,
    with_meta: true,
    meta_level: "basic",
  })
  const posts = await Promise.all(
    data.map(async (post): Promise<ListedPost> => {
      const url = await getFeaturedImageUrl(post.id).catch(() => null)
      return {
        post,
        href: postPath({ ...post, post_type: post.post_type || postType }, structure),
        image: publicImageUrl(siteUrl, url) ?? null,
      }
    }),
  )
  const total = meta.total ?? posts.length
  return { posts, total, page, links: pageLinks(basePath, page, perPage, total), siteTitle: site.title }
}
