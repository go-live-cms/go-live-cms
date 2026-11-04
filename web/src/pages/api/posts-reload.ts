import type { APIRoute } from "astro";
import { SERVER_MEDIA_URL } from "../../../gl-admin/lib/server-api-url";
import { log, requestIdHeaders } from "../../lib/log";

export const GET: APIRoute = async () => {
  // Server-side fetch, so the runtime SERVER_API_URL origin (the internal network
  // address), not PUBLIC_API_URL, which Astro inlines at build time. This route is
  // public, so it reads published posts from /public, never /api/v1/posts (the
  // admin's working copy, drafts included, #393).
  try {
    const response = await fetch(`${SERVER_MEDIA_URL}/public/posts?type=post`, { headers: requestIdHeaders() });

    if (!response.ok) {
      return new Response(JSON.stringify({ error: "Failed to fetch posts" }), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await response.json();

    return new Response(JSON.stringify(data.posts || []), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    log.error("posts_reload_failed", { error });
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
