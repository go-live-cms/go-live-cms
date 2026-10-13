/**
 * URL/CSS sanitization helpers for the public Block Spec v1 renderer (issue #188).
 *
 * Defence in depth alongside the server-side sanitizer in `api/post_blocks_sanitize.go`:
 * the server cleans content on save, but content already stored before the sanitizer
 * existed is only made safe here, at render time. React/Astro escape text and attribute
 * VALUES, but they do NOT block dangerous URL schemes (javascript:) or CSS values — these
 * helpers do. Keep the logic in sync with the Go sanitizer.
 */

const SAFE_HREF_SCHEMES = new Set(["http", "https", "mailto", "tel"])
const SAFE_IMAGE_SCHEMES = new Set(["http", "https"])

// Conservative CSS color allowlist: hex / rgb(a) / hsl(a) / named color. Rejects
// anything containing url(), semicolons, etc.
const SAFE_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\))$/

// NUL / TAB / LF / CR are stripped by browsers before URL parsing, so they can smuggle
// a scheme past a naive check (e.g. "java<TAB>script:"). Reject any URL containing them.
// (A literal space is NOT included — it is not a smuggling vector and legitimate paths
// like "/uploads/my image.png" can contain spaces.)
function hasUnsafeControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0 || c === 9 || c === 10 || c === 13) return true
  }
  return false
}

/** Returns the lowercased URL scheme, or null for a relative URL (no scheme). */
function schemeOf(s: string): string | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s)
  return m ? m[1].toLowerCase() : null
}

function isSafeUrl(raw: string | undefined | null, allowed: Set<string>): boolean {
  if (raw == null) return true
  const s = raw.trim()
  if (s === "") return true
  if (hasUnsafeControlChars(s)) return false
  const scheme = schemeOf(s)
  if (scheme === null) return true // relative URL (/uploads/x, #anchor, ?q=1, …)
  return allowed.has(scheme)
}

/** Safe href for a link, or `undefined` (caller should fall back to "#"). */
export function safeHref(href: string | undefined | null): string | undefined {
  return isSafeUrl(href, SAFE_HREF_SCHEMES) ? (href ?? undefined) : undefined
}

/** Safe image src, or "" when the URL scheme is not allowed. */
export function safeImageSrc(src: string | undefined | null): string {
  return isSafeUrl(src, SAFE_IMAGE_SCHEMES) ? (src ?? "") : ""
}

/** Safe CSS color value, or `undefined` when it isn't a recognised safe token. */
export function safeCssColor(color: string | undefined | null): string | undefined {
  if (color == null) return undefined
  const c = color.trim()
  if (c === "") return undefined
  return SAFE_COLOR_RE.test(c) ? color : undefined
}
