import { apiCall } from "../api"
import { buildUrl } from "./utils"

// Redirects (#331): GET/POST /redirects, DELETE /redirects/:id. Admins only, like
// every setting. A redirect applies only to an address the site answers 404 for; the
// API collapses chains and refuses loops.

// manual: added in Settings. post / term: a slug change added it. merge: merging tags.
export type RedirectSource = "manual" | "post" | "term" | "merge"

export interface RedirectCreator {
  id: number
  username: string
  full_name: string
  avatar: string | null
}

export interface Redirect {
  id: number
  // A site path: "/blog/old-post" (no query, no trailing slash).
  from_path: string
  // A site path or an absolute http(s) URL.
  to_path: string
  // 301 permanent, 302 temporary.
  status_code: 301 | 302
  source: RedirectSource
  // to_path is another site.
  external: boolean
  created_at: string
  // null: added by the system, or by a member removed since.
  created_by: RedirectCreator | null
}

export interface RedirectList {
  redirects: Redirect[]
  total: number
}

// Newest first. The API caps `limit` at 100.
export async function listRedirects(params: { q?: string; limit?: number; offset?: number } = {}): Promise<RedirectList> {
  const response = await apiCall(buildUrl("/redirects", params))
  return { redirects: response.redirects ?? [], total: response.total ?? 0 }
}

// 400 with the field's message, 400 redirect_loop, 409 redirect_exists.
export async function createRedirect(body: { from_path: string; to_path: string; status_code?: 301 | 302 }): Promise<Redirect> {
  const response = await apiCall("/redirects", { method: "POST", body })
  return response.redirect
}

export async function deleteRedirect(id: number): Promise<void> {
  await apiCall(`/redirects/${id}`, { method: "DELETE" })
}
