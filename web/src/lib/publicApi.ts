/**
 * The API's unauthenticated /public routes, for the SSR pages (author pages #350, term
 * archives #348).
 */
import { SERVER_MEDIA_URL } from "@gl-admin/lib/server-api-url"

// Like siteSettings: an unreachable API fails the call after a moment instead of
// hanging the page.
const PUBLIC_API_TIMEOUT_MS = 5000

// GET {API}/public{path}: the JSON body, or null for a 404. Anything else throws.
export async function getPublic<T>(path: string): Promise<T | null> {
  const response = await fetch(`${SERVER_MEDIA_URL}/public${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(PUBLIC_API_TIMEOUT_MS),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GET /public${path}: HTTP ${response.status}`)
  return (await response.json()) as T
}
