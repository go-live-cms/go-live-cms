import type { APIRoute } from "astro"
import { buildRobotsTxt, cacheControl, resolveSiteUrl } from "../lib/seo"

// Server route (not public/robots.txt) so the Sitemap line uses the configured
// site URL (SITE_URL) at runtime.
export const prerender = false

export const GET: APIRoute = ({ url }) =>
  new Response(buildRobotsTxt(resolveSiteUrl(url)), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": cacheControl(3600),
    },
  })
