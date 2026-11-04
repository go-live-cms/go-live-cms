import type { BlockDocV1 } from "../blocks-spec"

// Shared types for API modules

// Sort options for each resource
export type MediaSortOption =
  | "date_asc"
  | "date_desc"
  | "name_asc"
  | "name_desc"
  | "size_asc"
  | "size_desc"
  | "type_asc"
  | "type_desc"
  | "posts_asc"
  | "posts_desc"

// Post list sort column (#89); pair it with `order`. When `order` is omitted
// the API picks desc for created_at/changed_at/id and asc for title/menu_order.
export type PostSortField = "created_at" | "changed_at" | "title" | "id" | "menu_order"

export type SortOrder = "asc" | "desc"

// Columns plus the older combined values, which the API still accepts (an
// explicit `order` overrides their suffix).
export type PostSortOption =
  | PostSortField
  | "date_asc"
  | "date_desc"
  | "title_asc"
  | "title_desc"
  | "menu_order_asc"
  | "menu_order_desc"
  | "id_asc"
  | "id_desc"

export type UserSortOption =
  | "date_asc"
  | "date_desc"
  | "username_asc"
  | "username_desc"
  | "email_asc"
  | "email_desc"
  | "role_asc"
  | "role_desc"
  | "id_asc"
  | "id_desc"

export type TaxonomySortOption = "name_asc" | "name_desc" | "id_asc" | "id_desc" | "order_asc" | "order_desc"

// Pagination
export interface PaginationParams {
  limit?: number
  offset?: number
}

// API meta info
export interface ApiMeta {
  count?: number
  limit?: number
  offset?: number
  total?: number
}

// Generic API response
export interface ApiResponse<T> {
  data: T[]
  meta: ApiMeta
}

// Resource interfaces (simplified, expand as needed)
export interface PostType {
  id: number
  name: string
  label: string
  description: string
  hierarchical: boolean
  public: boolean
  has_archive: boolean
  menu_position: number | null
  supports: string[]
  is_active: boolean
  registered_by: string
  show_ui: boolean
  show_in_menu: boolean
  created_at: string
}

export interface Media {
  id: number
  name: string
  description: string
  alt: string
  media_path: string
  user_id: number
  created_at: string
  changed_at: string
  post_count?: number
  file_size: number
  mime_type: string
  width?: number
  height?: number
  duration?: number
  original_filename: string
  // Resized copies of an image (#255), keyed thumb/medium/large. An image
  // smaller than a size has no variant of it; {} for non-images. "social" is the
  // 1200 x 630 crop around the focal point for shared links (#357).
  variants?: Partial<Record<MediaVariantName | "social", MediaVariant>>
  // Point of interest (0..1 from the top-left), null when unset.
  focal_point?: FocalPoint | null
  // The image needs no alt text (a background, a divider) and is rendered alt="" (#325).
  decorative?: boolean
  // GET /media only: how many of the posts using it are published.
  published_post_count?: number
}

export interface Post {
  id: number
  title: string
  description: string
  published_blocks?: BlockDocV1
  featured_image?: string
  user_id: number
  username: string
  url: string
  slug?: string
  post_type: string
  post_status: string
  post_parent?: number | null
  menu_order: number
  created_at: string
  changed_at: string
  // Every credited author (user_posts) in byline order; only list rows fetched
  // with with_meta=true&meta_level=basic carry it (#340).
  authors?: PostAuthor[]
  // "Changes not published" (#326): published, and the working copy (body or settings)
  // differs from what the site shows. Lists and GET /posts/:id set it; absent = false.
  has_unpublished_changes?: boolean
  // The working SEO settings (#357): admin responses for one post (GET /posts/:id).
  seo?: PostSEOSettings
  // /public/posts rows only: the published "Hide from search engines" (#357), which
  // keeps the post out of the sitemap.
  noindex?: boolean
  // When a scheduled post publishes (#147), UTC ISO; null unless post_status is
  // "scheduled".
  publish_at?: string | null
  // The last failed attempt to publish it on schedule (GET /posts/:id only).
  schedule_failure?: ScheduleFailure | null
  // The trash (#327): when it was moved there (UTC ISO) and the status a restore brings
  // back. Only set while post_status is "trash".
  deleted_at?: string | null
  trashed_from_status?: string
  // When a published post's scheduled update goes live (#335), UTC ISO; absent when
  // none. Lists and GET /posts/:id.
  update_at?: string | null
  // That update in full (GET /posts/:id only).
  scheduled_update?: ScheduledUpdate | null
}

// A published post's pending update (#335): its content was frozen at scheduled_at.
export interface ScheduledUpdate {
  update_at: string
  scheduled_at: string
  scheduled_by: number | null
  // The last failed attempt to apply it ("update_failed"), retried at next_attempt_at.
  failure?: ScheduleFailure | null
}

// Why a scheduled post isn't live yet: the scheduler retries at next_attempt_at.
export interface ScheduleFailure {
  failed_at: string
  // "collab_flush_failed": the collaboration server couldn't save the latest edits.
  // "publish_failed": the publish itself failed.
  reason: string
  attempts: number
  next_attempt_at: string | null
}

// A post's SEO settings as the admin edits them (PUT /posts/:id/seo replaces them).
// "" / null = use the post's own (title; excerpt, then first paragraph; featured image).
export interface PostSEOSettings {
  seo_title: string
  seo_description: string
  social_image_id: number | null
  noindex: boolean
  canonical_url: string
}

export interface PostAuthor {
  id: number
  username: string
  full_name: string
  // Their avatar's /uploads URL (#334), or null.
  avatar?: string | null
}

// GET /posts/counts: posts per status (draft, published, archived, ...).
export interface PostStatusCounts {
  counts: Record<string, number>
  total: number
  // Published posts with changes not published (#326); also in counts.published.
  unpublished_changes: number
}

export interface User {
  id: number
  username: string
  full_name: string
  email: string
  role: string
  created_at: string
  password_changed_at?: string
  // Author profile (#350); "" when not set.
  bio?: string
  website?: string
  // Users screen rows only (GET /users, #333): null = no activity recorded.
  last_active_at?: string | null
  posts_owned?: number
  // Their avatar's /uploads URL (#334); null shows the initial.
  avatar?: string | null
}

// An author as the public site sees them (GET /public/authors/:username, #350): no
// email, role or id. avatar is the /uploads URL of their picture (#334), or null.
export interface AuthorProfile {
  username: string
  full_name: string
  avatar: string | null
  bio: string
  website: string
}

export interface TaxonomyType {
  id: number
  name: string
  label: string
  description: string
  hierarchical: boolean
  public: boolean
  show_ui: boolean
  show_in_menu: boolean
  created_at: string
}

export interface TaxonomyTerm {
  id: number
  name: string
  slug: string
  description: string
  parent_id?: number
  taxonomy_type_id: number
  taxonomy_type_name?: string
  sort_order?: number
  meta?: Record<string, any>
  post_count?: number
  created_at: string
}

// One signed-in browser or device (GET /auth/sessions, #334). last_used_at: the last
// sign-in or token refresh. client_ip only in debug mode.
export interface DeviceSession {
  id: string
  user_agent: string
  client_ip?: string
  last_used_at: string
  expires_at: string
  current: boolean
}

export interface Session {
  id: string
  user_id: number
  refresh_token: string
  user_agent: string
  client_ip: string
  is_blocked: boolean
  expires_at: string
  created_at: string
}

export type MediaVariantName = "thumb" | "medium" | "large"

export interface MediaVariant {
  path: string
  width: number
  height: number
  mime_type: string
  file_size: number
}

export interface FocalPoint {
  x: number
  y: number
}
