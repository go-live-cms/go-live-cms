import { apiCall, authenticatedFetch } from "../api"
import { apiErrorFromResponse } from "./errors"
import { buildUrl } from "./utils"

// The importer (#150): Posts › Import, admins only (api/imports.go). POST /imports reads
// a WordPress export or a zip of Markdown files into an import waiting for its mapping;
// /start queues it with the mapping and the server runs it in the background; the page
// polls GET /imports/:id and reads the report from /items. The editor's notice for an
// imported post is GET /posts/:id/import-notice (editors and admins).

export type ImportSource = "wxr" | "markdown"
export type ImportStatus = "mapping" | "queued" | "running" | "done" | "failed" | "cancelled"
export type ImportItemStatus = "pending" | "imported" | "skipped" | "failed"

export interface ImportAuthor {
  login: string
  display_name: string
  posts: number
  // A member with the same email or user name (0 = none).
  suggested_user_id: number
  matched_by?: "email" | "username"
}

export interface ImportTypeCount {
  type: string
  count: number
  published: number
  // The GoLive post type it maps to by default ("" = not imported).
  suggested: string
}

export interface ImportSummary {
  source: ImportSource
  site_url?: string
  site_host?: string
  title?: string
  items: number
  authors: ImportAuthor[]
  types: ImportTypeCount[]
  categories: number
  tags: number
  other_terms: number
  attachments: number
  files: number
  skipped: Record<string, number>
  not_imported: Record<string, number>
}

export interface ImportProgress {
  total: number
  pending: number
  imported: number
  skipped: number
  failed: number
  with_dropped: number
}

export interface ImportMapping {
  // login → member id (0 = the admin who starts the import).
  authors: Record<string, number>
  // export post type → GoLive post type ("" = not imported).
  types: Record<string, string>
}

export interface ImportJob {
  id: number
  source: ImportSource
  file_name: string
  site_url: string
  status: ImportStatus
  error?: string
  summary: ImportSummary
  mapping?: ImportMapping & { importer_id: number }
  created_by: number | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  progress: ImportProgress
  // Items an earlier import brought over (skipped when this one runs); while mapping only.
  imported_before?: number
}

export type ImportListItem = Pick<
  ImportJob,
  "id" | "source" | "file_name" | "site_url" | "status" | "error" | "summary" | "created_at" | "finished_at" | "progress"
>

export interface ImportDropped {
  label: string
  // The text of the block it followed.
  after?: string
  // The original markup, for "Copy the original as text".
  original: string
}

export interface ImportMediaFailure {
  url: string
  code: string
  reason: string
  after?: string
}

export interface ImportItemResult {
  dropped?: ImportDropped[]
  media_failed?: ImportMediaFailure[]
  notes?: string[]
  redirects?: string[]
  slug?: string
  post_id?: number
  error?: string
  publish_refused?: string
}

export interface ImportItem {
  id: number
  position: number
  type: string
  title: string
  status: ImportItemStatus
  reason?: string
  post_id: number | null
  post_type?: string
  post_status?: string
  result: ImportItemResult
  processed_at: string | null
}

export interface ImportNotice {
  item_id: number
  dropped: ImportDropped[]
  media_failed: ImportMediaFailure[]
}

// 422 with the reader's code (not_an_export, unsafe_zip, …), 413 too_large.
export async function uploadImport(file: File): Promise<ImportJob> {
  const form = new FormData()
  form.append("file", file)
  const response = await authenticatedFetch("/api/v1/imports", { method: "POST", body: form })
  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "The file couldn’t be read" })
  }
  const body = await response.json()
  return body.import
}

export async function listImports(): Promise<ImportListItem[]> {
  const response = await apiCall("/imports")
  return response.imports ?? []
}

export async function getImport(id: number): Promise<ImportJob> {
  const response = await apiCall(`/imports/${id}`)
  return response.import
}

export async function listImportItems(
  id: number,
  params: { status?: ImportItemStatus; dropped?: boolean; limit?: number; offset?: number } = {},
): Promise<ImportItem[]> {
  const response = await apiCall(
    buildUrl(`/imports/${id}/items`, { ...params, dropped: params.dropped ? "true" : undefined }),
  )
  return response.items ?? []
}

// 400 invalid_author / invalid_type, 409 already_started.
export async function startImport(id: number, mapping: ImportMapping): Promise<ImportJob> {
  const response = await apiCall(`/imports/${id}/start`, { method: "POST", body: mapping })
  return response.import
}

export async function cancelImport(id: number): Promise<ImportJob> {
  const response = await apiCall(`/imports/${id}/cancel`, { method: "POST" })
  return response.import
}

export async function deleteImport(id: number): Promise<void> {
  await apiCall(`/imports/${id}`, { method: "DELETE" })
}

// null when the post has no notice (404).
export async function getImportNotice(postId: number): Promise<ImportNotice | null> {
  try {
    const response = await apiCall(`/posts/${postId}/import-notice`)
    return response.notice ?? null
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null
    throw error
  }
}

export async function dismissImportNotice(postId: number, itemId: number): Promise<void> {
  await apiCall(`/posts/${postId}/import-notice/dismiss`, { method: "POST", body: { item_id: itemId } })
}
