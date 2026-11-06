import type { PostSeo } from "./seo"
import type { Post, PostSortOption, SortOrder, PaginationParams, ApiResponse, TaxonomyTerm, TaxonomyType } from "../../gl-admin/lib/api/types"
import { SERVER_API_URL, SERVER_MEDIA_URL } from "../../gl-admin/lib/server-api-url"
import type { Pagination } from "./pagination"
import { requestIdHeaders } from "./log"

const API_BASE = typeof window === "undefined" ? SERVER_API_URL : "/api/v1"


interface ApiOptions {
  method?: string
  body?: any
}

export async function apiCall(endpoint: string, options: ApiOptions = {}) {
  const { method = "GET", body } = options

  const config: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...requestIdHeaders(),
    },
  }

  if (body) {
    config.body = JSON.stringify(body)
  }

  const response = await fetch(`${API_BASE}${endpoint}`, config)

  if (!response.ok) {
    const error = await response.text()
    let message = `HTTP ${response.status}: ${error}`
    try {
      const errorObj = JSON.parse(error)
      if (errorObj?.error) message = errorObj.error
    } catch {
      // Not JSON: keep the raw body.
    }
    // status lets callers tell "not found" from a failure.
    throw Object.assign(new Error(message), { status: response.status })
  }

  const contentType = response.headers.get("content-type")
  if (!contentType || !contentType.includes("application/json")) {
    return {}
  }

  const text = await response.text()
  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export interface PostQueryParams extends PaginationParams {
  sort?: PostSortOption
  order?: SortOrder
  type?: string
  status?: string
  user_id?: string | number
  with_meta?: boolean
  meta_level?: string
}

// The public site never reads /api/v1/posts*: those routes serve the admin's working
// copy (drafts, unpublished edits) and need a sign-in (#393). Posts come from the API's
// /public group below (getPublicPost, getPublishedPosts, getPublicPostsPage).

export async function getTaxonomyTypes(): Promise<TaxonomyType[]> {
  const response = await apiCall("/taxonomy/types")
  return response.taxonomy_types || []
}

// Older/newer and related posts (#351). These live on the API's /public group (for
// SSR), not under /api/v1. Rows are with_meta list rows (meta, authors).
export interface AdjacentPosts {
  previous: Post | null
  next: Post | null
}

// The post renders without these parts rather than wait on a slow API.
const PUBLIC_EXTRAS_TIMEOUT_MS = 3000

async function publicApiCall(endpoint: string) {
  const response = await fetch(`${SERVER_MEDIA_URL}/public${endpoint}`, {
    headers: requestIdHeaders(),
    signal: AbortSignal.timeout(PUBLIC_EXTRAS_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

export async function getAdjacentPosts(postId: string | number): Promise<AdjacentPosts> {
  const data = await publicApiCall(`/posts/${postId}/adjacent`)
  return { previous: data?.previous ?? null, next: data?.next ?? null }
}

// taxonomy (e.g. "category") or termId limits the shared terms to that taxonomy or that
// one term, and then only posts sharing one come back; without either the latest posts
// fill in.
export async function getRelatedPosts(postId: string | number, params: { limit?: number; taxonomy?: string; termId?: number } = {}): Promise<Post[]> {
  const query = new URLSearchParams()
  if (params.limit) query.set("limit", String(params.limit))
  if (params.taxonomy) query.set("taxonomy", params.taxonomy)
  if (params.termId) query.set("term_id", String(params.termId))
  const qs = query.toString()
  const data = await publicApiCall(`/posts/${postId}/related${qs ? `?${qs}` : ""}`)
  return Array.isArray(data?.posts) ? data.posts : []
}

export async function getSettings(): Promise<any> {
  return apiCall("/settings")
}

// Theme API
export interface Theme {
  id: number
  name: string
  slug: string
  description: string
  version: string
  author: string
  config: any
  active: boolean
  created_at: string
  changed_at: string
}

export interface ActiveThemeWithSettings extends Theme {
  settings: Record<string, any>
}

export async function getThemes(): Promise<Theme[]> {
  return apiCall("/themes")
}

export async function getActiveTheme(): Promise<ActiveThemeWithSettings> {
  return apiCall("/themes/active")
}

export async function activateTheme(themeId: number): Promise<Theme> {
  return apiCall(`/themes/${themeId}/activate`, { method: "PUT" })
}

export async function updateActiveThemeSettings(settings: Record<string, any>): Promise<any> {
  return apiCall("/themes/active/settings", {
    method: "PUT",
    body: { settings },
  })
}

export interface PostTypeInfo {
  id: number
  name: string
  label: string
  description: string
  public: boolean
  hierarchical: boolean
  has_archive: boolean
  menu_position: number | null
  supports: string[]
  is_active: boolean
  registered_by: string
}

export async function getPostTypes(): Promise<PostTypeInfo[]> {
  // The API wraps the list: {"post_types": [...]}.
  const response = await apiCall("/post-types")
  return Array.isArray(response) ? response : response.post_types || []
}

// Names of the post types the public site serves: registered, active and
// public. Anything else 404s on /[post_type] and /[post_type]/[id].
export async function getPublicPostTypeNames(): Promise<string[]> {
  const types = await getPostTypes()
  return types.filter((t) => t.is_active !== false && t.public !== false).map((t) => t.name)
}

export interface PublicPostPage {
  posts: Post[]
  pagination: Pagination
}

// One numbered page of a public post type's published posts, posts_per_page at a
// time (#349, GET /public/posts/type/:type). null when the API has no such page: the
// type isn't public or the page is past the end. Other failures throw.
export async function getPublicPostsPage(type: string, page: number): Promise<PublicPostPage | null> {
  const query = page > 1 ? `?page=${page}` : ""
  const response = await fetch(`${SERVER_MEDIA_URL}/public/posts/type/${encodeURIComponent(type)}${query}`, { headers: requestIdHeaders() })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`HTTP ${response.status} listing ${type} posts`)
  const body = await response.json()
  return { posts: body.posts || [], pagination: body.pagination }
}

// A published post as the site shows it (#358, GET /public/posts/:id or
// /public/posts/slug/:slug): its published title, excerpt, featured image and terms,
// never the working ones an editor is changing. Drafts, archived posts and unknown
// ids/slugs are null; other failures throw, with the status.
export interface PublicPost {
  post: Post
  featured_image: { id: number | null; url: string } | null
  taxonomy_terms: TaxonomyTerm[]
  // The published SEO settings (#357); absent from an older API.
  seo?: PostSeo
}

export async function getPublicPost(idOrSlug: string | number): Promise<PublicPost | null> {
  const key = String(idOrSlug)
  const path = /^\d+$/.test(key) ? `/public/posts/${key}` : `/public/posts/slug/${encodeURIComponent(key)}`
  const response = await fetch(`${SERVER_MEDIA_URL}${path}`, { headers: requestIdHeaders() })
  if (response.status === 404) return null
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} loading a post`), { status: response.status })
  const body = await response.json()
  if (!body?.post) return null
  return { post: body.post, featured_image: body.featured_image ?? null, taxonomy_terms: body.taxonomy_terms ?? [], seo: body.seo ?? undefined }
}

// The page the site shows at / (#336, GET /public/front-page), as getPublicPost answers
// it, or null when / shows the latest posts (none chosen, or it isn't a published page
// any more). Any other failure throws: an API error must not turn the front page into the
// post list.
export async function getPublicFrontPage(): Promise<PublicPost | null> {
  const response = await fetch(`${SERVER_MEDIA_URL}/public/front-page`, { headers: requestIdHeaders() })
  if (response.status === 404) return null
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} loading the front page`), { status: response.status })
  const body = await response.json()
  if (!body?.post) return null
  return { post: body.post, featured_image: body.featured_image ?? null, taxonomy_terms: body.taxonomy_terms ?? [], seo: body.seo ?? undefined }
}

// A public type's published posts with their published titles and excerpts (#358,
// GET /public/posts): the feeds and short "latest posts" lists. Same sort and paging
// parameters as the admin list (GET /posts); a type that isn't public is an error (404).
export async function getPublishedPosts(type: string, params: Pick<PostQueryParams, "limit" | "offset" | "sort" | "order"> = {}): Promise<ApiResponse<Post>> {
  const searchParams = new URLSearchParams({ type })
  if (params.limit) searchParams.set("limit", params.limit.toString())
  if (params.offset) searchParams.set("offset", params.offset.toString())
  if (params.sort) searchParams.set("sort", params.sort)
  if (params.order) searchParams.set("order", params.order)
  const response = await fetch(`${SERVER_MEDIA_URL}/public/posts?${searchParams}`, { headers: requestIdHeaders() })
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} listing ${type} posts`), { status: response.status })
  const body = await response.json()
  return {
    data: body.posts || [],
    meta: body.meta || { count: 0, limit: 20, offset: 0, total: 0 },
  }
}
