import { authenticatedFetch } from "../api"
import { apiErrorFromResponse } from "./errors"
import type { ContrastFailure, FontOption } from "@/lib/globalStyles"

// The site design's REST routes (#485, docs/design/theme-builder.md 6.5 and 8.2), admins
// only: the global styles draft and the publish. Templates and parts are edited through
// the collab server, never here.

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

export interface SiteDesignPublishResponse {
  release: { id: number; theme_slug: string; published_at: string }
  global_styles: { version_no: number; groups: string[]; contrast_failures: number }
  styles: GlobalStylesResponse
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

export async function getGlobalStyles(): Promise<GlobalStylesResponse> {
  const response = await authenticatedFetch("/api/v1/site-design/global-styles")
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
  const response = await authenticatedFetch("/api/v1/site-design/global-styles", {
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
 * POST /site-design/publish: the one publish call of the styles screen (#487). For now it
 * publishes the global styles only; #492 generalizes it to templates, parts and styles in
 * one release, so this is the function it swaps. Failing contrast is
 * ContrastUnconfirmedError unless `confirmContrast` (it asks, never refuses); a draft
 * saved by someone else meanwhile is StylesChangedError.
 */
export async function publishSiteDesign({
  confirmContrast = false,
}: { confirmContrast?: boolean } = {}): Promise<SiteDesignPublishResponse> {
  const response = await authenticatedFetch("/api/v1/site-design/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm_contrast: confirmContrast }),
  })
  const conflict = await conflictBody(response)
  if (conflict?.code === "contrast_unconfirmed")
    throw new ContrastUnconfirmedError((conflict.pairs as ContrastFailure[]) ?? [])
  if (conflict?.code === "styles_changed" && conflict.current)
    throw new StylesChangedError(conflict.current as GlobalStylesResponse)
  if (!response.ok) throw await apiErrorFromResponse(response, { fallback: "Publishing the site design failed" })
  return response.json()
}
