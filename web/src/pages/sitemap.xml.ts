import type { APIRoute } from "astro"
import { getPostsByType, getPublicPostTypeNames, getSettings } from "../lib/api"
import { getPublicAuthors } from "../lib/authorPage"
import { buildSitemapXml, cacheControl, collectSitemapEntries, normalizeUrlStructure, resolveSiteUrl } from "../lib/seo"

// Built from the API: post pages are server-rendered, so @astrojs/sitemap
// (prebuilt pages only) could never list them.
export const prerender = false

const MAX_AGE_SECONDS = 600

// Building the sitemap walks every published post (one API call per 100 posts
// per type), all from this server's IP, so it is cached in memory for its
// max-age, per site URL, and concurrent requests share one build. Otherwise
// repeated hits could use up the API's per-IP rate limit (#190) and 429 every
// page render.
const cache = new Map<string, { xml: Promise<string>; expires: number }>()

function buildSitemap(siteUrl: string): Promise<string> {
  return collectSitemapEntries(siteUrl, {
    getPublicPostTypeNames,
    getUrlStructure: async () => {
      try {
        return normalizeUrlStructure((await getSettings())?.post_url_structure)
      } catch (error) {
        console.warn("[sitemap] Could not fetch settings, using id URLs:", error)
        return "id"
      }
    },
    getPublishedPosts: async (type, limit, offset) =>
      (await getPostsByType(type, { status: "published", sort: "id", order: "asc", limit, offset })).data,
    // Author pages (#350). Without them the posts are still worth listing.
    getAuthors: () =>
      getPublicAuthors().catch((error) => {
        console.warn("[sitemap] Could not fetch authors, leaving author pages out:", error)
        return []
      }),
  }).then(buildSitemapXml)
}

export const GET: APIRoute = async ({ url }) => {
  const siteUrl = resolveSiteUrl(url)
  const now = Date.now()
  let cached = cache.get(siteUrl)
  if (!cached || cached.expires <= now) {
    cached = { xml: buildSitemap(siteUrl), expires: now + MAX_AGE_SECONDS * 1000 }
    // Without SITE_URL the key comes from the Host header: keep one entry so
    // spoofed hosts can't grow the map.
    cache.clear()
    cache.set(siteUrl, cached)
  }

  try {
    return new Response(await cached.xml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": cacheControl(MAX_AGE_SECONDS),
      },
    })
  } catch (error) {
    // Don't cache the failure; the next request retries.
    if (cache.get(siteUrl) === cached) cache.delete(siteUrl)
    // An empty sitemap would tell crawlers every post is gone; ask them to retry.
    console.error("[sitemap] Failed to build sitemap:", error)
    return new Response("Sitemap temporarily unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "300" },
    })
  }
}
