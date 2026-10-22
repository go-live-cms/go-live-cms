import type { APIRoute } from "astro";
import { SERVER_API_URL } from "../../../gl-admin/lib/server-api-url";

export const GET: APIRoute = async () => {
  // Server-side fetch, so the runtime SERVER_API_URL (the internal network address),
  // not PUBLIC_API_URL, which Astro inlines at build time.
  const API_BASE = SERVER_API_URL;

  try {
    const response = await fetch(`${API_BASE}/posts`);

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
    console.error("API route error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
