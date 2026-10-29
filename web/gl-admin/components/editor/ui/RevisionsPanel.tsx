import { useCallback, useEffect, useState } from "react"
import Notice from "@gl-admin/components/ui/Notice"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import BlockRenderer from "@/components/BlockRenderer"
import { blockAPIClient, type PostVersion, type PostVersionSummary } from "@gl-admin/lib/api/blockAPI"
import { errorMessage } from "@gl-admin/lib/api/errors"
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
 * changes only when it's published again. Comparing with the working copy ("Highlight
 * changes") is #355.
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

      {error && (
        <Notice tone="danger" live="alert" className="revisions-panel__error" actions={<button type="button" className="revisions-panel__retry" onClick={load}>Try again</button>}>
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

// A version in the canvas, read-only (History · 1).
export function VersionPreview({ version }: { version: PostVersion }) {
  return (
    <article className="revisions-preview" aria-readonly="true">
      <p className="revisions-preview__about">
        {version.created_by_username ? `Published by ${version.created_by_username} on ` : "Published on "}
        <strong>{versionTime(version.created_at)}</strong>. Read-only.
      </p>
      {version.doc.blocks_order.length === 0 ? (
        <p className="revisions-panel__empty">This version is empty.</p>
      ) : (
        <div className="revisions-preview__content">
          <BlockRenderer doc={version.doc} />
        </div>
      )}
    </article>
  )
}
