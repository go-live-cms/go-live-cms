import type { Post } from "@gl-admin/lib/types"
import type { CollabStatus, CollabUser } from "@gl-admin/components/editor/utils/useCollabPresence"
import "@gl-admin/assets/styles/components/editor/publish-bar.scss"

interface PublishBarProps {
  post: Post
  onSave: () => void
  onPublish: () => void
  isSaving: boolean
  isPublishing: boolean
  saveStatus: "saved" | "saving" | "error" | null
  onSettingsToggle: () => void
  onPreview?: () => void
  collabStatus?: CollabStatus
  collabUsers?: CollabUser[]
}

export default function PublishBar({
  post,
  onSave,
  onPublish,
  isSaving,
  isPublishing,
  saveStatus,
  onSettingsToggle,
  onPreview,
  collabStatus = "disconnected",
  collabUsers = [],
}: PublishBarProps) {
  const statusLabel =
    collabStatus === "connected" ? "Connected" : collabStatus === "connecting" ? "Connecting…" : "Offline"

  const getSaveStatusText = () => {
    switch (saveStatus) {
      case "saving":
        return "Saving..."
      case "saved":
        return "Saved"
      case "error":
        return "Save failed"
      default:
        return ""
    }
  }

  const getContentTypeName = () => {
    switch (post.post_type) {
      case "post":
        return "Post"
      case "page":
        return "Page"
      default:
        return "Content"
    }
  }

  return (
    <div className="publish-bar">
      {/* left side: presence */}
      <div className="publish-bar__presence" title={statusLabel}>
        <span className={`presence-dot presence-dot--${collabStatus}`} />
        {collabUsers.slice(0, 3).map((u) => (
          <div
            key={`presence-${u.clientId}`}
            className="presence-avatar"
            style={{ backgroundColor: u.color || "#999" }}
            title={`${u.name ?? "Guest"} • ${statusLabel}`}
          >
            {(u.name ?? "G").charAt(0).toUpperCase()}
          </div>
        ))}
        {collabUsers.length > 3 && (
          <div className="presence-avatar presence-avatar--more" title={`${collabUsers.length - 3} more`}>
            +{collabUsers.length - 3}
          </div>
        )}

        {/* Hover card */}
        <div className="presence-hover">
          <div className="presence-hover__header">{statusLabel}</div>
          {collabUsers.length === 0 && (
            <div className="presence-hover__row presence-hover__row--muted">No other editors</div>
          )}
          {collabUsers.map((u) => (
            <div key={`hover-${u.clientId}`} className="presence-hover__row">
              <span className="presence-hover__swatch" style={{ backgroundColor: u.color || "#999" }} />
              <span className="presence-hover__name">{u.name ?? "Guest"}</span>
            </div>
          ))}
        </div>
      </div>

      {/* right side: existing controls (save/publish/settings) */}
      <div className="publish-bar__actions">
        {saveStatus && (
          <div className={`publish-bar__right__save-status publish-bar__right__save-status--${saveStatus}`}>
            {getSaveStatusText()}
          </div>
        )}

        <div className="publish-bar__right__actions">
          <button type="button" className="btn btn--secondary" onClick={onSettingsToggle} title="Toggle Sidebar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
              <line x1="15" y1="3" x2="15" y2="21" stroke="currentColor" strokeWidth="2" />
            </svg>
            Sidebar
          </button>

          <button
            type="button"
            className="btn btn--secondary"
            onClick={onSave}
            disabled={isSaving || isPublishing}
            title="Ctrl+S"
          >
            {isSaving ? "Saving..." : "Save Draft"}
          </button>

          <button type="button" className="btn btn--primary" onClick={onPublish} disabled={isSaving || isPublishing}>
            {isPublishing ? "Publishing..." : post.post_status === "published" ? "Update" : "Publish"}
          </button>
        </div>
      </div>
    </div>
  )
}
