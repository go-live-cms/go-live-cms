// Production forwarding of /api/v1 and /uploads to the Go API (#143).
//
// The admin SPA calls the API same-origin (/api/v1/..., media under /uploads/...), and
// the refresh cookie belongs to the web host. In dev the Vite proxy in astro.config.mjs
// forwards those paths before Astro sees them. The production image runs the standalone
// Node server, which has no Vite, so the middleware forwards them with this instead.
// Astro's own /api routes (/api/theme, /api/posts-reload) are not under /api/v1.

const HOP_BY_HOP_REQUEST = [
  "connection",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  // Node's fetch refuses any request carrying Expect, so forwarding it turned every such
  // request into a 502. .NET clients send `Expect: 100-continue` on each POST, curl on
  // bodies over 1 MB. The Node server has already answered the 100 Continue itself.
  "expect",
]

// fetch() has already decoded the body, so the upstream encoding/length no longer apply.
const DROPPED_RESPONSE = ["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]

export function isApiProxyPath(pathname: string): boolean {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/") || pathname.startsWith("/uploads/")
}

export async function proxyToApi(
  request: Request,
  // The browser's IP as the web server saw it (Astro's clientAddress).
  clientAddress: string | undefined,
  // API origin without /api/v1, e.g. http://api:8080 (SERVER_MEDIA_URL).
  apiOrigin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url)
  const target = new URL(url.pathname + url.search, apiOrigin)

  const headers = new Headers(request.headers)
  for (const name of HOP_BY_HOP_REQUEST) headers.delete(name)
  // Same as the dev proxy's xfwd: append the peer, so the API (which only reads
  // X-Forwarded-For from TRUSTED_PROXIES) rate-limits the browser, not this server.
  if (clientAddress) {
    const prior = headers.get("x-forwarded-for")
    headers.set("x-forwarded-for", prior ? `${prior}, ${clientAddress}` : clientAddress)
  }
  headers.set("x-forwarded-host", url.host)
  headers.set("x-forwarded-proto", url.protocol.replace(/:$/, ""))

  const hasBody = request.method !== "GET" && request.method !== "HEAD"
  let upstream: Response
  try {
    upstream = await fetchImpl(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      // Required by Node's fetch to stream a request body (media uploads).
      duplex: "half",
    } as RequestInit)
  } catch (error) {
    console.error("API proxy: upstream request failed:", error)
    return new Response(JSON.stringify({ error: "API unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    })
  }

  // Copying the Headers keeps every Set-Cookie (the refresh cookie) as its own entry.
  const responseHeaders = new Headers(upstream.headers)
  for (const name of DROPPED_RESPONSE) responseHeaders.delete(name)
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}
