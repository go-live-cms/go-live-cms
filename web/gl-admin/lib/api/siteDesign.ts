import { apiCall, authenticatedFetch } from "../api"
import { apiErrorFromResponse } from "./errors"
import type { ContrastFailure, FontOption } from "@/lib/globalStyles"
import type { BlockDocV1 } from "../blocks-spec"

// The site design's REST routes (#485, #487, #492; docs/design/theme-builder.md 5.3, 6.5,
// 8, 9), admins only: the global styles draft, the one "Publish site design", history,
// reset and restore. The working copy of a template or part is edited through the collab
// server, never here: restoring one goes through the editor (rule 9,
// lib/collaboration/templateRestore.ts), which uses these routes to fetch what to put in
// and to record it afterwards.

/** GET/PUT /site-design/global-styles: the active theme's styles as the form needs them. */
export interface GlobalStylesResponse {
  theme: { id: number; slug: string; name: string }
  // The theme's layout merges global styles and this build knows its tokens.
  supported: boolean
  // The theme's declared tokens with their defaults (ThemeConfig's token groups).
  tokens: Record<string, unknown>
  font_options: FontOption[]
  system_fonts: string[]
  draft: Record<string, unknown>
  draft_revision: number
  published: Record<string, unknown>
  has_unpublished_changes: boolean
  // The pairs the stored draft fails (a warning, never a refusal).
  contrast: ContrastFailure[]
  changed_at: string | null
}

export type SiteTemplateKind = "template" | "part"

/** One template or part a release published: its new version; reset when the theme's default renders again. */
export interface SiteTemplatePublished {
  id: number
  kind: SiteTemplateKind
  slug: string
  title: string
  version_no: number
  reset: boolean
}

export interface SiteDesignPublishResponse {
  release: { id: number; theme_slug: string; published_at: string }
  /** Null when the styles had no changes (a templates-only release). */
  global_styles: { version_no: number; groups: string[]; contrast_failures: number } | null
  templates: SiteTemplatePublished[]
  styles: GlobalStylesResponse
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

/** A template or part that would go live fails (409 design_invalid): nothing was published. */
export class DesignInvalidError extends Error {
  constructor(
    message: string,
    readonly problems: SiteDesignProblem[]
  ) {
    super(message)
    this.name = "DesignInvalidError"
  }
}

/** Another admin saved the styles since `base_revision` (409 styles_changed): nothing was written. */
export class StylesChangedError extends Error {
  constructor(readonly current: GlobalStylesResponse) {
    super("Another admin changed the styles. The form now shows their version.")
    this.name = "StylesChangedError"
  }
}

/** Publish without `confirmContrast` while pairs fail (409 contrast_unconfirmed): nothing was published. */
export class ContrastUnconfirmedError extends Error {
  constructor(readonly pairs: ContrastFailure[]) {
    super("Some colour pairs are hard to read. Publish anyway to go ahead.")
    this.name = "ContrastUnconfirmedError"
  }
}

async function conflictBody(response: Response): Promise<Record<string, unknown> | null> {
  if (response.status !== 409) return null
  return (await response
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null
}

/**
 * authenticatedFetch, plus apiCall's 401 rule: the server may revoke a token the client
 * still thinks is fresh (a password change), so a 401 gets a real refresh and one retry.
 * A form open for a long time would otherwise fail every save until the refresh timer.
 */
export async function designFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await authenticatedFetch(url, init)
  if (response.status !== 401) return response
  // Imported here, as apiCall does, to keep the auth module out of this one's import cycle.
  const { authManager } = await import("../auth")
  let refreshed = false
  try {
    refreshed = await authManager.forceRefresh()
  } catch {
    // A failed refresh clears auth itself; the 401 stands.
  }
  return refreshed ? authenticatedFetch(url, init) : response
}

export async function getGlobalStyles(): Promise<GlobalStylesResponse> {
  const response = await designFetch("/api/v1/site-design/global-styles")
  if (!response.ok) throw await apiErrorFromResponse(response, { fallback: "Loading the styles failed" })
  return response.json()
}

/**
 * PUT /site-design/global-styles: the whole draft, with the revision it was made to.
 * Throws StylesChangedError when someone else saved first, else an ApiError (400 carries
 * the validator's code: unknown_token, invalid_value or token_order).
 */
export async function saveGlobalStyles(
  styles: Record<string, unknown>,
  baseRevision: number
): Promise<GlobalStylesResponse> {
  const response = await designFetch("/api/v1/site-design/global-styles", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ styles, base_revision: baseRevision }),
  })
  const conflict = await conflictBody(response)
  if (conflict?.code === "styles_changed" && conflict.current)
    throw new StylesChangedError(conflict.current as GlobalStylesResponse)
  if (!response.ok) throw await apiErrorFromResponse(response, { fallback: "Saving the styles failed" })
  return response.json()
}

/**
 * POST /site-design/publish (#492, design 8.2): the one "Publish site design" call, for the
 * styles screen (#487) and the Site editor. It publishes every changed template, part and
 * the global styles of the active theme in one release. The API flushes the templates and
 * parts being edited first (503 `collab_unavailable` naming one: nothing published).
 * Failing contrast is ContrastUnconfirmedError unless `confirmContrast` (it asks, never
 * refuses); a draft saved by someone else meanwhile is StylesChangedError; a template or
 * part that fails is DesignInvalidError with its `problems`. Others (`nothing_to_publish`,
 * `design_changed`: publish again) are ApiErrors whose message says what happened.
 */
export async function publishSiteDesign({
  confirmContrast = false,
}: { confirmContrast?: boolean } = {}): Promise<SiteDesignPublishResponse> {
  const response = await designFetch("/api/v1/site-design/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm_contrast: confirmContrast }),
  })
  const conflict = await conflictBody(response)
  if (conflict?.code === "contrast_unconfirmed")
    throw new ContrastUnconfirmedError((conflict.pairs as ContrastFailure[]) ?? [])
  if (conflict?.code === "styles_changed" && conflict.current)
    throw new StylesChangedError(conflict.current as GlobalStylesResponse)
  if (conflict?.code === "design_invalid")
    throw new DesignInvalidError(String(conflict.error ?? "Nothing was published"), (conflict.problems as SiteDesignProblem[]) ?? [])
  if (!response.ok) throw await apiErrorFromResponse(response, { fallback: "Publishing the site design failed" })
  return response.json()
}

// ---- Templates and parts (#492) ----

export type SiteTemplateChange = "publish" | "reset" | ""

export interface SiteTemplate {
  id: number
  theme_slug: string
  kind: SiteTemplateKind
  slug: string
  title: string
  /** Absent in the overview; GET /site-design/templates/:id has it. */
  block_doc?: BlockDocV1
  block_revision: number
  working_state: "custom" | "reset"
  source: "theme" | "starter" | "blank"
  source_hash: string
  /** It has a published copy (the theme's default renders when it hasn't). */
  published: boolean
  doc_name: string
  created_at: string
  changed_at: string
  /** What the next publish does to it (8.1): "" = no unpublished changes. */
  change: SiteTemplateChange
  has_unpublished_changes: boolean
  /** Absent in the overview; null when nothing is published. */
  published_block_doc?: BlockDocV1 | null
  /** The last published version (a reset version when `published` is false). */
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
export async function getSiteTemplateVersion(
  id: number,
  versionNo: number
): Promise<{ version_no: number; reset: boolean; block_doc: BlockDocV1 | null }> {
  return apiCall(`/site-design/templates/${id}/versions/${versionNo}`)
}

/** After the editor restored a version (rule 9): a reset item becomes custom again, and the restore is recorded. */
export async function recordSiteTemplateRestore(id: number, versionNo: number): Promise<SiteTemplate> {
  return apiCall(`/site-design/templates/${id}/versions/${versionNo}/restore`, { method: "POST" })
}

// ---- History (#492) ----

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

/** The active theme's releases, newest first. */
export async function listSiteDesignReleases(
  options: { limit?: number; before?: number } = {}
): Promise<{ releases: SiteDesignRelease[]; next_before: number | null }> {
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
export async function restoreGlobalStyleVersion(versionNo: number, baseRevision: number): Promise<GlobalStylesResponse> {
  return apiCall(`/site-design/global-styles/versions/${versionNo}/restore`, {
    method: "POST",
    body: { base_revision: baseRevision },
  })
}

/** Discard changes to the styles: the published styles become the draft again. */
export async function discardGlobalStyles(baseRevision: number): Promise<GlobalStylesResponse> {
  return apiCall("/site-design/global-styles/discard", { method: "POST", body: { base_revision: baseRevision } })
}
