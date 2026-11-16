import type * as Y from "yjs"
import type { Editor } from "@tiptap/core"
import type { BlockDocV1 } from "../blocks-spec"
import type { CollabSaveStatus } from "./CollabSaveStatus"
import { restoreVersionLive } from "./liveRestore"
import * as siteDesignApi from "../api/siteDesign"
import type { SiteTemplate } from "../api/siteDesign"

/**
 * Restore, Discard changes and Start over for a template or part (#492, design 5.3, 8.2,
 * 9). Rule 9 holds: the doc goes into the working copy **through the editor**
 * (`restoreVersionLive`: `setEditorBlockDoc`, mirrored to every peer as an ordinary edit,
 * then the collab server's next `stored`), never by REST, and the API is told
 * afterwards only to record it (working_state back to custom, the source of a Start over,
 * the activity). The API never writes `site_templates.block_doc` for these (rule 11).
 *
 * `editor` is the Site editor's bound editor on `template-<id>` and must be editable: the
 * Site editor makes a reset item's editor read-only (section 9), so it unlocks it for the
 * restore (or calls Keep editing first); a revoked or outdated connection stays read-only
 * and the restore throws.
 */

/** The API calls these flows make, injectable for tests. */
export interface TemplateRestoreApi {
  getSiteTemplateVersion: typeof siteDesignApi.getSiteTemplateVersion
  recordSiteTemplateRestore: typeof siteDesignApi.recordSiteTemplateRestore
  getSiteTemplateDefault: typeof siteDesignApi.getSiteTemplateDefault
  recordSiteTemplateStartOver: typeof siteDesignApi.recordSiteTemplateStartOver
}

const defaultApi: TemplateRestoreApi = siteDesignApi

export interface TemplateRestoreTarget {
  editor: Editor
  ydoc: Y.Doc
  status: CollabSaveStatus
  templateId: number
}

export interface TemplateRestoreResult {
  /** The server confirmed a store holding it (else it stores it later; the save status shows the outcome). */
  saved: boolean
  /** Blocks of it this editor can't show, kept hidden in `meta.dropped` (#213). */
  dropped: number
  /** The row as the API now has it. */
  template: SiteTemplate
}

/** A version that reset the item has no doc: Reset to theme default is how to get it again. */
export class ResetVersionError extends Error {
  constructor(readonly versionNo: number) {
    super(`Version ${versionNo} reset this to the theme default; use Reset to theme default instead`)
    this.name = "ResetVersionError"
  }
}

/** Never published: nothing to go back to. Discard is Delete for it (it asks first). */
export class NeverPublishedError extends Error {
  constructor() {
    super("This has never been published; delete it to go back to the theme default")
    this.name = "NeverPublishedError"
  }
}

async function intoEditor(target: TemplateRestoreTarget, doc: BlockDocV1, timeoutMs?: number) {
  return restoreVersionLive(target.editor, doc, target.ydoc, target.status, timeoutMs ? { timeoutMs } : {})
}

/**
 * History's Restore: version `versionNo` into the working copy through the editor, then
 * recorded (a reset item is editable again: the next publish puts the version live; a
 * reset publishes NULL, and this brings it back).
 */
export async function restoreTemplateVersion(
  target: TemplateRestoreTarget,
  versionNo: number,
  { api = defaultApi, timeoutMs }: { api?: TemplateRestoreApi; timeoutMs?: number } = {}
): Promise<TemplateRestoreResult> {
  const version = await api.getSiteTemplateVersion(target.templateId, versionNo)
  if (!version.block_doc) throw new ResetVersionError(versionNo)
  const { saved, dropped } = await intoEditor(target, version.block_doc, timeoutMs)
  const template = await api.recordSiteTemplateRestore(target.templateId, versionNo)
  return { saved, dropped, template }
}

/**
 * Discard changes (8.2): the published copy back into the working copy, through the
 * editor: it is History's restore of the published version. An item never published
 * throws `NeverPublishedError` (Delete is its discard). A reset that was published needs no
 * doc: Keep editing is enough when the working copy is already the published one, but
 * restoring the published version covers both.
 */
export async function discardTemplateChanges(
  target: TemplateRestoreTarget,
  template: Pick<SiteTemplate, "published_version_no">,
  options: { api?: TemplateRestoreApi; timeoutMs?: number } = {}
): Promise<TemplateRestoreResult> {
  if (template.published_version_no == null) throw new NeverPublishedError()
  return restoreTemplateVersion(target, template.published_version_no, options)
}

/**
 * Start over from the theme default (section 9): the theme's shipped default (or core's
 * starter, `from`) through the editor, then the row records where it starts from now, so
 * "Default changed since you customized" clears.
 */
export async function startOverTemplate(
  target: TemplateRestoreTarget,
  { from, api = defaultApi, timeoutMs }: { from?: "theme" | "starter"; api?: TemplateRestoreApi; timeoutMs?: number } = {}
): Promise<TemplateRestoreResult> {
  const fallback = await api.getSiteTemplateDefault(target.templateId, from)
  const { saved, dropped } = await intoEditor(target, fallback.block_doc, timeoutMs)
  const template = await api.recordSiteTemplateStartOver(target.templateId, fallback.source)
  return { saved, dropped, template }
}
