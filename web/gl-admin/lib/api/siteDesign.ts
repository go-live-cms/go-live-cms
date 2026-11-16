import { apiCall } from "../api"
import type { BlockDocV1 } from "../blocks-spec"

// Publish site design, history, reset and restore (#492, docs/design/theme-builder.md 5.3,
// 8.1, 8.2, 9). Admins only. `publishSiteDesign` is the one "Publish site design" entry
// point: it publishes every changed template, part and the global styles of the active
// theme under one release (the styles screen, #487, and the Site editor, #493, both call
// it). Templates and parts restore through the editor, never by REST (rule 9): see
// lib/collaboration/templateRestore.ts, which uses the routes below to fetch what to put
// into the editor and to record it afterwards.

export type SiteTemplateKind = "template" | "part"
export type SiteTemplateChange = "publish" | "reset" | ""

export interface SiteTemplate {
  id: number
  theme_slug: string
  kind: SiteTemplateKind
  slug: string
  title: string
  block_doc: BlockDocV1
  block_revision: number
  working_state: "custom" | "reset"
  source: "theme" | "starter" | "blank"
  source_hash: string
  published: boolean
  doc_name: string
  created_at: string
  changed_at: string
  /** What the next publish does to it (8.1): "" = no unpublished changes. */
  change: SiteTemplateChange
  has_unpublished_changes: boolean
  published_block_doc: BlockDocV1 | null
  published_version_no: number | null
  /** The theme default (or starter) it started from changed since (section 9). */
  default_changed: boolean
  /** Nothing of it is published, so Delete may remove it (section 9). */
  can_delete: boolean
}

export interface SiteDesignOverview {
  theme: { id: number; slug: string; name: string }
  templates: SiteTemplate[]
  global_styles_changed: boolean
  global_styles_groups: string[]
  /** The Publish button's count: changed templates and parts, plus 1 for the styles. */
  unpublished_changes: number
}

export interface SiteTemplatePublished {
  id: number
  kind: SiteTemplateKind
  slug: string
  title: string
  version_no: number
  /** This version reset it: the theme's default renders again. */
  reset: boolean
}

export interface SiteDesignPublishResult {
  release: { id: number; theme_slug: string; published_at: string }
  /** Null when the styles had no changes. */
  global_styles: { version_no: number; groups: string[]; contrast_failures: number } | null
  templates: SiteTemplatePublished[]
  /** GET /site-design/global-styles's shape, as it now is. */
  styles: unknown
}

/** One reason a publish was refused (409 design_invalid's `problems`). */
export interface SiteDesignProblem {
  code: "template_empty" | "template_invalid" | "part_unresolved"
  id?: number
  kind: SiteTemplateKind
  slug: string
  part?: string
  reason?: string
}

/**
 * Publish site design (8.2). The API flushes every template and part being edited first
 * (503 `collab_unavailable` naming it: nothing published), validates (409 `design_invalid`
 * with `problems`, 409 `contrast_unconfirmed` with `pairs` unless `confirmContrast`),
 * then publishes everything together. Other answers: 409 `nothing_to_publish`,
 * `design_changed` / `styles_changed` (something moved meanwhile: publish again).
 * The body is #485's `{confirm_contrast}`, so a styles-only caller needs no change.
 */
export async function publishSiteDesign({ confirmContrast = false }: { confirmContrast?: boolean } = {}): Promise<SiteDesignPublishResult> {
  return apiCall("/site-design/publish", { method: "POST", body: { confirm_contrast: confirmContrast } })
}

export async function getSiteDesignOverview(): Promise<SiteDesignOverview> {
  return apiCall("/site-design/templates")
}

export async function getSiteTemplate(id: number): Promise<SiteTemplate> {
  return apiCall(`/site-design/templates/${id}`)
}

/** Reset to theme default (section 9): the editor turns read-only; the next publish puts the default back. */
export async function resetSiteTemplate(id: number): Promise<SiteTemplate> {
  return apiCall(`/site-design/templates/${id}/reset`, { method: "POST" })
}

/** Keep editing: undoes a reset. */
export async function keepEditingSiteTemplate(id: number): Promise<SiteTemplate> {
  return apiCall(`/site-design/templates/${id}/keep-editing`, { method: "POST" })
}

/** Delete a template or part with nothing published (409 `template_published` otherwise). Its history goes too. */
export async function deleteSiteTemplate(id: number): Promise<{ deleted: true; id: number }> {
  return apiCall(`/site-design/templates/${id}`, { method: "DELETE" })
}

export interface SiteTemplateDefault {
  source: "theme" | "starter"
  source_hash: string
  block_doc: BlockDocV1
}

/** What "Start over" puts into the editor: the theme's default, else core's starter (fresh block ids). */
export async function getSiteTemplateDefault(id: number, from?: "theme" | "starter"): Promise<SiteTemplateDefault> {
  return apiCall(`/site-design/templates/${id}/default${from ? `?from=${from}` : ""}`)
}

/** After the editor put the default in: the row starts from it now. */
export async function recordSiteTemplateStartOver(id: number, from?: "theme" | "starter"): Promise<SiteTemplate> {
  return apiCall(`/site-design/templates/${id}/start-over`, { method: "POST", body: from ? { from } : {} })
}

export interface SiteTemplateVersion {
  version_no: number
  release_id: number
  reset: boolean
  created_at: string
  published_by: number | null
  published_by_name: string
  current: boolean
}

export async function listSiteTemplateVersions(id: number): Promise<SiteTemplateVersion[]> {
  const { versions } = await apiCall(`/site-design/templates/${id}/versions`)
  return versions
}

/** A version's doc; null for a version that reset the item. */
export async function getSiteTemplateVersion(id: number, versionNo: number): Promise<{ version_no: number; reset: boolean; block_doc: BlockDocV1 | null }> {
  return apiCall(`/site-design/templates/${id}/versions/${versionNo}`)
}

/** After the editor restored a version (rule 9): a reset item becomes custom again, and the restore is recorded. */
export async function recordSiteTemplateRestore(id: number, versionNo: number): Promise<SiteTemplate> {
  return apiCall(`/site-design/templates/${id}/versions/${versionNo}/restore`, { method: "POST" })
}

export interface SiteDesignRelease {
  id: number
  theme_slug: string
  published_at: string
  published_by: number | null
  published_by_name: string
  summary: Record<string, unknown>
  items: SiteTemplatePublished[]
  global_styles_version: number | null
}

/** History: the active theme's releases, newest first. */
export async function listSiteDesignReleases(options: { limit?: number; before?: number } = {}): Promise<{ releases: SiteDesignRelease[]; next_before: number | null }> {
  const params = new URLSearchParams()
  if (options.limit) params.set("limit", String(options.limit))
  if (options.before) params.set("before", String(options.before))
  const query = params.toString()
  return apiCall(`/site-design/releases${query ? `?${query}` : ""}`)
}

export async function listGlobalStyleVersions(): Promise<Array<Omit<SiteTemplateVersion, "reset">>> {
  const { versions } = await apiCall("/site-design/global-styles/versions")
  return versions
}

/** Restore a styles version into the draft (REST: styles aren't collaborative). 409 `styles_changed` on a stale revision. */
export async function restoreGlobalStyleVersion(versionNo: number, baseRevision: number): Promise<unknown> {
  return apiCall(`/site-design/global-styles/versions/${versionNo}/restore`, { method: "POST", body: { base_revision: baseRevision } })
}

/** Discard changes to the styles: the published styles become the draft again. */
export async function discardGlobalStyles(baseRevision: number): Promise<unknown> {
  return apiCall("/site-design/global-styles/discard", { method: "POST", body: { base_revision: baseRevision } })
}
