import React from "react"
import MediaCard from "./MediaCard"
import type { Media } from "@gl-admin/lib/types"

interface MediaGridProps {
  mediaItems: Media[]
  loading?: boolean
  error?: string | null
  emptyState?: {
    title?: string
    description?: string
    icon?: React.ReactNode
  }
  className?: string
  onMediaSelect?: (media: Media) => void
  selectedMedia?: Media[]
  selectable?: boolean
}

const MediaGrid: React.FC<MediaGridProps> = ({
  mediaItems,
  loading = false,
  error = null,
  emptyState = {
    title: "No media files yet",
    description: 'Upload your first file by clicking "New Media" above',
  },
  className = "",
  onMediaSelect,
  selectedMedia = [],
  selectable = false,
}) => {
  const handleMediaClick = (media: Media) => {
    if (selectable && onMediaSelect) {
      onMediaSelect(media)
    }
  }

  const isSelected = (media: Media) => {
    return selectedMedia.some((selected) => selected.id === media.id)
  }

  if (loading) {
    return (
      <div className={`gl-admin-media__container ${className}`}>
        <div className="gl-admin-media__grid">
          {Array.from({ length: 12 }).map((_, index) => (
            <div key={index} className="gl-admin-media-card">
              <div className="gl-admin-media-card__thumbnail skeleton"></div>
              <div className="gl-admin-media-card__content">
                <div className="gl-admin-media-card__title skeleton"></div>
                <div className="gl-admin-media-card__meta skeleton"></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={`gl-admin-media__container ${className}`}>
        <div className="error-message">
          <strong>Error:</strong> {error}
        </div>
      </div>
    )
  }

  if (mediaItems.length === 0) {
    return (
      <div className={`gl-admin-media__container ${className}`}>
        <div className="empty-state">
          {emptyState.icon || <div className="empty-icon" />}
          <h3>{emptyState.title}</h3>
          <p>{emptyState.description}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={`gl-admin-media__container ${className}`}>
      <div className="gl-admin-media__grid">
        {mediaItems.map((media) => (
          <div
            key={media.id}
            className={`gl-admin-media-card-wrapper${selectable ? " gl-admin-media-card-wrapper--selectable" : ""}${
              isSelected(media) ? " gl-admin-media-card-wrapper--selected" : ""
            }`}
            onClick={() => handleMediaClick(media)}
          >
            <MediaCard media={media} />
            {selectable && (
              <div className="gl-admin-media-card__checkbox">
                <input
                  type="checkbox"
                  checked={isSelected(media)}
                  onChange={() => handleMediaClick(media)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default MediaGrid
