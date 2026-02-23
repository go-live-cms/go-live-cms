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

export type PostSortOption =
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
}

export interface User {
  id: number
  username: string
  full_name: string
  email: string
  role: string
  created_at: string
  password_changed_at?: string
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
