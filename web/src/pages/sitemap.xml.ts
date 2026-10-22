import type { APIRoute } from "astro"
import { getPostsByType, getPublicPostTypeNames, getSettings } from "../lib/api"
import { buildSitemapXml, collectSitemapEntries, normalizeUrlStructure, resolveSiteUrl } from "../lib/seo"

// Built per request from the API: post pages are server-rendered, so
// @astrojs/sitemap (prebuilt pages only) could never list them.
export const prerender = false

export const GET: APIRoute = async ({ url }) => {
  try {
    const entries = await collectSitemapEntries(resolveSiteUrl(url), {
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
        (await getPostsByType(type, { status: "published", sort: "date_desc", limit, offset })).data,
    })

    return new Response(buildSitemapXml(entries), {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=600",
      },
    })
  } catch (error) {
    // An empty sitemap would tell crawlers every post is gone; ask them to retry.
    console.error("[sitemap] Failed to build sitemap:", error)
    return new Response("Sitemap temporarily unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "300" },
    })
  }
}
