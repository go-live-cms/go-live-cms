// Content-Security-Policy for the admin SPA (/gl-admin, #161).
//
// The admin shell is SSR'd by Astro and then React takes over (client:only). Every
// <script> in that shell is ours (Astro's island runtime, the hoisted module entry, the
// define:vars inline in the admin Layout); nothing user-controlled is rendered into it.
// So the middleware stamps a per-request nonce on each <script> tag of the shell and
// script-src allows only 'self' + that nonce: no 'unsafe-inline', and a script injected
// later by an XSS in the SPA (innerHTML, a theme block, an attribute handler) is blocked.

export interface AdminCspOptions {
  nonce: string
  // Origin the page was requested on, e.g. "https://cms.example.com". Collab runs on the
  // same host under /collab in prod, so its ws/wss origin is derived from this.
  pageOrigin: string
  // PUBLIC_API_URL. The browser normally calls the API same-origin (/api/v1, /uploads via
  // the proxy), but absolute media URLs point at this origin.
  apiUrl?: string
  dev: boolean
}

function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

// The ws:/wss: twin of an http(s) origin. CSP3 lets 'self' match same-host websockets,
// but older Safari doesn't, so list them explicitly.
function wsOriginOf(origin: string): string {
  return origin.replace(/^http/, "ws")
}

export function buildAdminCsp({ nonce, pageOrigin, apiUrl, dev }: AdminCspOptions): string {
  const apiOrigin = originOf(apiUrl)
  const extra = (list: (string | null)[]) => list.filter((s): s is string => !!s && s !== pageOrigin)

  const connectSrc = [
    "'self'",
    wsOriginOf(pageOrigin), // prod collab: wss://<host>/collab (CollaborationProvider.ts)
    ...extra([apiOrigin]),
  ]
  const scriptSrc = ["'self'", `'nonce-${nonce}'`]

  if (dev) {
    // Dev: the collab server is hardcoded to localhost:1234 (CollaborationProvider.ts),
    // and Vite's HMR socket lives on the dev server's own origin (covered above).
    connectSrc.push("ws://localhost:1234")
  }

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    // 'unsafe-inline' for styles is a deliberate exception: TipTap injects a <style>
    // element at editor creation, Settings renders a React <style>, the inline SVG icons
    // carry style attributes, Vite injects CSS as <style> tags in dev, and Astro inlines
    // small stylesheets in prod builds. Inline CSS can't execute script, so the XSS
    // protection that matters here (script-src) stays strict.
    "style-src": ["'self'", "'unsafe-inline'"],
    // blob: for local image previews before upload; data: for inline SVG/icons.
    "img-src": ["'self'", "data:", "blob:", ...extra([apiOrigin])],
    "font-src": ["'self'", "data:"],
    "connect-src": connectSrc,
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  }

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ")
}

// Adds nonce="..." to every <script> start tag that doesn't already carry one.
export function addNonceToScripts(html: string, nonce: string): string {
  return html.replace(/<script\b([^>]*)>/gi, (tag, attrs: string) =>
    /\snonce\s*=/i.test(attrs) ? tag : `<script nonce="${nonce}"${attrs}>`,
  )
}

export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
}

export function isAdminPath(pathname: string): boolean {
  return pathname === "/gl-admin" || pathname.startsWith("/gl-admin/")
}

// Wraps an admin HTML response: nonces its scripts and sets the CSP header. Non-HTML
// responses (e.g. /gl-admin/assets/*) pass through untouched.
export async function applyAdminCsp(
  response: Response,
  opts: Omit<AdminCspOptions, "nonce"> & { reportOnly?: boolean },
): Promise<Response> {
  const type = response.headers.get("content-type") || ""
  if (!type.includes("text/html")) return response

  const nonce = generateNonce()
  const html = addNonceToScripts(await response.text(), nonce)
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.set(
    opts.reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy",
    buildAdminCsp({ ...opts, nonce }),
  )
  return new Response(html, { status: response.status, statusText: response.statusText, headers })
}
