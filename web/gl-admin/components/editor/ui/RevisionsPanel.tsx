import { useCallback, useEffect, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import BlockRenderer from "@/components/BlockRenderer"
import { blockAPIClient, type PostVersion, type PostVersionSummary } from "@gl-admin/lib/api/blockAPI"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import "@gl-admin/assets/styles/components/editor/revisions-panel.scss"

interface RevisionsPanelProps {
  postId: number
  // Bumped by the parent after publish/unpublish so the list reloads
  refreshKey?: number
  // Loads the doc into the working copy through the editor; resolves when done
  onRestore: (version: PostVersion) => Promise<void>
}

/**
 * Revisions viewer (#136): the Block Spec v1 snapshots stored on every publish.
 * Restoring replaces the working copy (through the editor, so collaborators see it);
 * the public site only changes when the restored content is published again.
 */
export default function RevisionsPanel({ postId, refreshKey = 0, onRestore }: RevisionsPanelProps) {
  const [versions, setVersions] = useState<PostVersionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<PostVersion | null>(null)
  const [busyVersion, setBusyVersion] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await blockAPIClient.listVersions(postId)
      setVersions(list.versions)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load revisions")
    } finally {
      setLoading(false)
    }
  }, [postId])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  const loadVersion = async (versionNo: number) => {
    try {
      return await blockAPIClient.getVersion(postId, versionNo)
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to load version ${versionNo}`)
      return null
    }
  }

  const handleView = async (versionNo: number) => {
    setBusyVersion(versionNo)
    try {
      const version = await loadVersion(versionNo)
      if (version) setViewing(version)
    } finally {
      setBusyVersion(null)
    }
  }

  // Confirm before downloading anything, then hold the busy latch across fetch +
  // restore. `loaded` is passed when the version is already open in the preview.
  const handleRestore = async (versionNo: number, loaded?: PostVersion) => {
    const ok = window.confirm(
      `Replace the current draft with version ${versionNo}? ` +
        "Anyone editing this post will see the change. The live page stays as it is until you publish."
    )
    if (!ok) return
    setBusyVersion(versionNo)
    try {
      const version = loaded ?? (await loadVersion(versionNo))
      if (!version) return
      await onRestore(version)
      setViewing(null)
    } finally {
      setBusyVersion(null)
    }
  }

  return (
    <div className="revisions-panel">
      <div className="revisions-panel__header">
        <h4>Revisions</h4>
        <button type="button" className="revisions-panel__refresh" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>
      <small className="post-settings__field-description">
        A revision is saved every time this post is published.
      </small>

      {error && <small className="post-settings__field-error">{error}</small>}
      {loading && versions.length === 0 && <p className="revisions-panel__empty">Loading…</p>}
      {!loading && !error && versions.length === 0 && (
        <p className="revisions-panel__empty">No revisions yet. Publish to create the first one.</p>
      )}

      <ul className="revisions-panel__list">
        {versions.map((v) => (
          <li key={v.id} className="revisions-panel__item" data-testid={`revision-${v.version_no}`}>
            <div className="revisions-panel__meta">
              <span className="revisions-panel__number">v{v.version_no}</span>
              {v.is_published && <span className="revisions-panel__badge">Live</span>}
              <span className="revisions-panel__date">{new Date(v.created_at).toLocaleString()}</span>
            </div>
            {(v.label || v.message) && (
              <div className="revisions-panel__note">{[v.label, v.message].filter(Boolean).join(" · ")}</div>
            )}
            {v.created_by_username && <div className="revisions-panel__author">by {v.created_by_username}</div>}
            <div className="revisions-panel__actions">
              <Button variation="secondary" onClick={() => handleView(v.version_no)} disabled={busyVersion !== null}>
                View
              </Button>
              <Button variation="secondary" onClick={() => handleRestore(v.version_no)} disabled={busyVersion !== null}>
                {busyVersion === v.version_no ? "Working…" : "Restore"}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <Modal
        isOpen={viewing !== null}
        onClose={() => setViewing(null)}
        title={viewing ? `Version ${viewing.version_no}` : undefined}
        size="large"
        footer={
          viewing && (
            <div className="revisions-panel__modal-footer">
              <Button variation="flat" onClick={() => setViewing(null)}>
                Close
              </Button>
              <Button variation="primary" onClick={() => handleRestore(viewing.version_no, viewing)} disabled={busyVersion !== null}>
                Restore this version
              </Button>
            </div>
          )
        }
      >
        {viewing && <VersionPreview doc={viewing.doc} />}
      </Modal>
    </div>
  )
}

function VersionPreview({ doc }: { doc: BlockDocV1 }) {
  if (doc.blocks_order.length === 0) {
    return <p className="revisions-panel__empty">This version is empty.</p>
  }
  return (
    <div className="revisions-panel__preview">
      <BlockRenderer doc={doc} />
    </div>
  )
}
