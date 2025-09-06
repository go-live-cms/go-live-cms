import React from "react"
import type { Post } from "@gl-admin/lib/types"
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
}: PublishBarProps) {
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
      <div className="publish-bar__left">
        <div className="publish-bar__left__title">{post.title || "Untitled"}</div>
        <div className={`publish-bar__left__status publish-bar__left__status--${post.post_status}`}>
          {post.post_status}
        </div>
      </div>

      <div className="publish-bar__right">
        {saveStatus && (
          <div className={`publish-bar__right__save-status publish-bar__right__save-status--${saveStatus}`}>
            {getSaveStatusText()}
          </div>
        )}

        <div className="publish-bar__right__actions">
          <button type="button" className="btn btn--secondary" onClick={onSettingsToggle} title="Toggle Sidebar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M3 12h6m0 0V6m0 6v6m6-6h6m-6 0V6m0 6v6" stroke="currentColor" strokeWidth="2" />
              <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" fill="none" />
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
