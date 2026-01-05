export interface User {
  id: number
  username: string
  full_name: string
  email: string
  role: string
  created_at: string
  password_changed_at?: string
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

export interface Post {
  id: number
  title: string
  description: string
  user_id: number
  username: string
  post_type: string
  post_status: string
  url: string
  created_at: string
  changed_at: string
}

export interface PostType {
  id: number
  name: string
  label: string
  description: string
  hierarchical: boolean
  public: boolean
  show_ui: boolean
  show_in_menu: boolean
  supports: string[]
  created_at: string
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

// API Query Types
export type PostSortOption =
  | "created_at_asc"
  | "created_at_desc"
  | "title_asc"
  | "title_desc"
  | "author_asc"
  | "author_desc"
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
export type TaxonomySortOption =
  | "name_asc"
  | "name_desc"
  | "created_at_asc"
  | "created_at_desc"
  | "post_count_asc"
  | "post_count_desc"

export interface PaginationParams {
  limit?: number
  offset?: number
}

export interface ApiMeta {
  count: number
  limit: number
  offset: number
  total: number
}

export interface ApiResponse<T> {
  data: T[]
  meta: ApiMeta
}
