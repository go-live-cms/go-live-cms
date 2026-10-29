import rss from "@astrojs/rss"
import type { APIRoute } from "astro"
import type { Post } from "@gl-admin/lib/api/types"
import { getPostsByType } from "../lib/api"
import { cacheControl, metaDescription, normalizeUrlStructure, postPath, resolveSiteUrl } from "../lib/seo"
import { getSiteSettings } from "../lib/siteSettings"

// The site's latest published posts (#345; it used to list the Astro starter's sample
// markdown). Post pages are server-rendered, so the feed is built from the API.
export const prerender = false

const MAX_AGE_SECONDS = 600

export const GET: APIRoute = async ({ url }) => {
  const siteUrl = resolveSiteUrl(url)
  const site = await getSiteSettings()
  const structure = normalizeUrlStructure(site.urlStructure)
  let posts: Post[]
  try {
    posts = (await getPostsByType("post", { status: "published", sort: "date_desc", limit: 20 })).data
  } catch (error) {
    console.error("[rss] Failed to fetch posts:", error)
    return new Response("Feed temporarily unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "300" },
    })
  }
  const response = await rss({
    title: site.title,
    description: `The latest posts from ${site.title}`,
    site: siteUrl,
    items: posts.map((post) => ({
      title: post.title,
      link: postPath({ ...post, post_type: post.post_type || "post" }, structure),
      pubDate: new Date(post.created_at),
      description: metaDescription(post.description, 400) || undefined,
    })),
  })
  response.headers.set("Cache-Control", cacheControl(MAX_AGE_SECONDS))
  return response
}
