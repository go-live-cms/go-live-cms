import { useCallback, useEffect, useId, useMemo, useState } from "react"
import Notice from "@gl-admin/components/ui/Notice"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import BlockRenderer from "@/components/BlockRenderer"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import {
  blockAPIClient,
  type PostSettings,
  type PostVersion,
  type PostVersionSummary,
} from "@gl-admin/lib/api/blockAPI"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { authManager } from "@gl-admin/lib/auth"
import type { BlockDocDiff } from "@gl-admin/lib/history/blockDiff"
import { computeBlockDiff, DiffAbortedError } from "@gl-admin/lib/history/diffClient"
import { useHighlightChanges } from "@gl-admin/lib/history/highlightChanges"
import VersionDiff, {
  diffSummaryText,
  SettingsDiff,
  TitleDiff,
  VERSION_ONLY_LABEL,
  WORKING_ONLY_LABEL,
} from "./VersionDiff"
import { useFileBlockMedia } from "@gl-admin/lib/docMedia"
import "@gl-admin/assets/styles/components/editor/revisions-panel.scss"

interface RevisionsPanelProps {
  postId: number
  // Bumped by the parent after publish/unpublish/restore so the list reloads
  refreshKey?: number
  // The version shown in the canvas, if any (null: the working copy).
  viewingVersionNo?: number | null
  // Shows a version in the canvas (History · 1); the parent confirms a restore.
  onView: (version: PostVersion) => void
  onBackToWorkingCopy: () => void
}

// "Oct 26, 15:04", the way the History boards name a version.
export function versionTime(iso: string): string {
  const d = new Date(iso)
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  return `${date}, ${time}`
}

/**
 * History (#136, restyled in #341): the Block Spec v1 snapshot stored on every publish,
 * newest first. Picking one shows it read-only in the canvas; restoring replaces the
 * working copy through the editor (rule 9), so collaborators see it, and the public site
 * changes only when it's published again. "Highlight changes" (#355) compares the version
 * shown with the working copy (VersionPreview); the switch lives in memory only.
 */
export default function RevisionsPanel({
  postId,
  refreshKey = 0,
  viewingVersionNo = null,
  onView,
  onBackToWorkingCopy,
}: RevisionsPanelProps) {
  const [versions, setVersions] = useState<PostVersionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyVersion, setBusyVersion] = useState<number | null>(null)
  const [highlight, setHighlight] = useHighlightChanges()
  const highlightLabelId = useId()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await blockAPIClient.listVersions(postId)
      setVersions(list.versions)
    } catch (e) {
      setError(errorMessage(e, "Couldn't load the history"))
    } finally {
      setLoading(false)
    }
  }, [postId])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  const handleView = async (versionNo: number) => {
    setBusyVersion(versionNo)
    setError(null)
    try {
      onView(await blockAPIClient.getVersion(postId, versionNo))
    } catch (e) {
      setError(errorMessage(e, "Couldn't load that version"))
    } finally {
      setBusyVersion(null)
    }
  }

  return (
    <div className="revisions-panel">
      <p className="revisions-panel__intro">
        Each publish saves a version. Restoring one replaces the working copy; the live post changes only when someone
        publishes.
      </p>

      <div className="revisions-panel__highlight">
        <span id={highlightLabelId}>Highlight changes</span>
        <button
          type="button"
          role="switch"
          className="revisions-panel__switch"
          aria-checked={highlight}
          aria-labelledby={highlightLabelId}
          onClick={() => setHighlight(!highlight)}
        >
          <span aria-hidden="true" className="revisions-panel__switch-knob" />
        </button>
      </div>

      {error && (
        <Notice
          tone="danger"
          live="alert"
          className="revisions-panel__error"
          actions={
            <button type="button" className="revisions-panel__retry" onClick={load}>
              Try again
            </button>
          }
        >
          {error}
        </Notice>
      )}

      <ol className="revisions-panel__list">
        <li>
          <button
            type="button"
            className="revisions-panel__item"
            aria-current={viewingVersionNo === null ? "true" : undefined}
            onClick={onBackToWorkingCopy}
          >
            <span className="revisions-panel__row">
              <span className="revisions-panel__time">Working copy</span>
              <span className="revisions-panel__tag">Editing</span>
            </span>
          </button>
        </li>

        <li aria-hidden="true" className="revisions-panel__group">
          Published versions
        </li>
        {loading && versions.length === 0 && (
          <li className="revisions-panel__loading" aria-busy="true">
            <Skeleton width="60%" height={14} />
            <Skeleton width="40%" height={10} />
          </li>
        )}
        {!loading && !error && versions.length === 0 && (
          <li className="revisions-panel__empty">No versions yet. Publishing saves the first one.</li>
        )}
        {versions.map((v) => (
          <li key={v.id} data-testid={`revision-${v.version_no}`}>
            <button
              type="button"
              className="revisions-panel__item"
              aria-current={viewingVersionNo === v.version_no ? "true" : undefined}
              aria-busy={busyVersion === v.version_no || undefined}
              disabled={busyVersion !== null}
              onClick={() => handleView(v.version_no)}
            >
              <span className="revisions-panel__row">
                <span className="revisions-panel__time">{versionTime(v.created_at)}</span>
                {v.is_published && <span className="revisions-panel__tag revisions-panel__tag--live">Live</span>}
              </span>
              <span className="revisions-panel__meta">
                {v.created_by_username ? `Published by ${v.created_by_username}` : "Published"}
              </span>
              {(v.label || v.message) && (
                <span className="revisions-panel__meta">{[v.label, v.message].filter(Boolean).join(" · ")}</span>
              )}
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** A REST block doc as a full one: `{}` (a post that never had blocks, rule 14) is empty. */
/** No doc yet (the comparison is loading): stable, so the media hook doesn't loop. */
const EMPTY_DOC: BlockDocV1 = { doc_version: 1, blocks_order: [], blocks: {} }

function fullDoc(doc: BlockDocV1 | Record<string, never> | null | undefined): BlockDocV1 {
  const d = doc as Partial<BlockDocV1> | null | undefined
  return {
    doc_version: 1,
    blocks_order: Array.isArray(d?.blocks_order) ? d.blocks_order : [],
    blocks: d?.blocks && typeof d.blocks === "object" ? d.blocks : {},
  }
}

type Comparison =
  | { state: "off" }
  | { state: "loading" }
  | {
      state: "ready"
      postId: number
      versionNo: number
      diff: BlockDocDiff
      working: BlockDocV1
      settings: PostSettings | null
    }
  | { state: "error"; message: string }

interface VersionPreviewProps {
  version: PostVersion
  // The post, to compare with its working copy ("Highlight changes", #355). Without it the
  // version is only shown.
  postId?: number
  // Changes when the collab server stored the working copy (anyone's edits): the
  // comparison re-reads it.
  workingKey?: number
}

/**
 * A version in the canvas, read-only (History · 1). With "Highlight changes" on it is
 * compared with the working copy as the collab server last stored it (`GET
 * /posts/:id/blocks`, re-read on every store): the comparison reads REST data only, never
 * the live editor or the Yjs document, and changes nothing. The diff runs in a worker
 * (diffClient.ts). Restoring is unchanged: PostForm's restoreVersionLive (rule 9).
 */
export function VersionPreview({ version, postId, workingKey = 0 }: VersionPreviewProps) {
  const [highlight] = useHighlightChanges()
  const compare = highlight && postId !== undefined
  const [comparison, setComparison] = useState<Comparison>({ state: compare ? "loading" : "off" })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!compare || postId === undefined) {
      setComparison({ state: "off" })
      return
    }
    const controller = new AbortController()
    // A fresher working copy of the same version: keep the last comparison until it's in.
    setComparison((prev) =>
      prev.state === "ready" && prev.postId === postId && prev.versionNo === version.version_no
        ? prev
        : { state: "loading" }
    )
    void (async () => {
      try {
        const token = authManager.getAccessToken()
        if (token) blockAPIClient.setAuthToken(token)
        const [blocks, settings] = await Promise.all([
          blockAPIClient.getPostBlocks(postId),
          // Only versions with settings (#358) compare them; the blocks matter more.
          version.settings
            ? blockAPIClient
                .getSettingsState(postId)
                .then((s) => s.working)
                .catch(() => null)
            : Promise.resolve(null),
        ])
        if (controller.signal.aborted) return
        const working = fullDoc(blocks.doc)
        const diff = await computeBlockDiff(fullDoc(version.doc), working, { signal: controller.signal })
        if (controller.signal.aborted) return
        setComparison({ state: "ready", postId, versionNo: version.version_no, diff, working, settings })
      } catch (e) {
        if (controller.signal.aborted || e instanceof DiffAbortedError) return
        setComparison({ state: "error", message: errorMessage(e, "Couldn't compare it with the working copy") })
      }
    })()
    return () => controller.abort()
  }, [compare, postId, version, workingKey, attempt])

  const ready =
    comparison.state === "ready" && comparison.postId === postId && comparison.versionNo === version.version_no
      ? comparison
      : null
  // Stable per version, so a re-render of the page doesn't re-render a long comparison.
  // Video, audio and file blocks render from the media map (#423, `lib/docMedia.ts`).
  const versionDoc = useFileBlockMedia(useMemo(() => fullDoc(version.doc), [version]))
  const workingDoc = useFileBlockMedia(ready?.working ?? EMPTY_DOC)
  const title = version.settings?.title?.trim() ? version.settings.title : null

  return (
    <article className="revisions-preview" aria-readonly="true" aria-busy={comparison.state === "loading" || undefined}>
      <div className="revisions-preview__about">
        <span className="revisions-preview__about-text">
          {version.created_by_username ? `Published by ${version.created_by_username} on ` : "Published on "}
          <strong>{versionTime(version.created_at)}</strong>
          {compare ? ", compared with the working copy" : ""}. Read-only.
        </span>
        {ready && (
          <span className="revisions-preview__key">
            <span className="revisions-preview__key-item revisions-preview__key-item--version">
              <span aria-hidden="true" className="revisions-preview__swatch revisions-preview__swatch--version" />
              <ins className="version-diff__ins">{VERSION_ONLY_LABEL}</ins>
            </span>
            <span className="revisions-preview__key-item revisions-preview__key-item--working">
              <span aria-hidden="true" className="revisions-preview__swatch revisions-preview__swatch--working" />
              <del className="version-diff__del">{WORKING_ONLY_LABEL}</del>
            </span>
          </span>
        )}
      </div>

      {compare && (
        <p role="status" className="revisions-preview__status">
          {comparison.state === "loading"
            ? "Comparing with the working copy…"
            : ready
              ? diffSummaryText(ready.diff)
              : ""}
        </p>
      )}
      {comparison.state === "error" && (
        <Notice
          tone="danger"
          live="alert"
          className="revisions-preview__error"
          actions={
            <button type="button" className="revisions-panel__retry" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          }
        >
          {comparison.message}
        </Notice>
      )}

      {ready && version.settings && ready.settings && (
        <SettingsDiff version={version.settings} working={ready.settings} />
      )}

      {title && <TitleDiff version={title} working={ready?.settings ? ready.settings.title : null} />}

      {ready && !(versionDoc.blocks_order.length === 0 && ready.working.blocks_order.length === 0) ? (
        <div className="revisions-preview__content">
          <VersionDiff diff={ready.diff} version={versionDoc} working={workingDoc} />
        </div>
      ) : versionDoc.blocks_order.length === 0 ? (
        <p className="revisions-panel__empty">This version is empty.</p>
      ) : (
        <div className="revisions-preview__content">
          <BlockRenderer doc={versionDoc} />
        </div>
      )}
    </article>
  )
}
