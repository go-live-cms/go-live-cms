import React from "react"
import MediaCard from "./MediaCard"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import Button from "@gl-admin/components/ui/Button"
import type { Media } from "@gl-admin/lib/types"

interface MediaGridProps {
  mediaItems: Media[]
  loading?: boolean
  // A readable message (see errorMessage in lib/api/errors.ts).
  error?: string | null
  onRetry?: () => void
  emptyState?: {
    title?: string
    description?: React.ReactNode
    // Name of an svg in assets/icons.
    icon?: string
    action?: React.ReactNode
  }
  className?: string
  onMediaSelect?: (media: Media) => void
  selectedMedia?: Media[]
  selectable?: boolean
  onMediaClick?: (media: Media) => void
}

const MediaGrid: React.FC<MediaGridProps> = ({
  mediaItems,
  loading = false,
  error = null,
  onRetry,
  emptyState = {
    title: "No media files yet",
    description: 'Upload your first file by clicking "New Media" above',
  },
  className = "",
  onMediaSelect,
  selectedMedia = [],
  selectable = false,
  onMediaClick,
}) => {
  const handleMediaClick = (media: Media) => {
    if (selectable && onMediaSelect) {
      onMediaSelect(media)
    }
  }

  const handleCardClick = (media: Media) => {
    if (!selectable && onMediaClick) {
      onMediaClick(media)
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
        <EmptyState
          variant="error"
          icon="close"
          title="Couldn't load media"
          description={error}
          action={
            onRetry && (
              <Button variation="primary" onClick={onRetry}>
                Try again
              </Button>
            )
          }
        />
      </div>
    )
  }

  if (mediaItems.length === 0) {
    return (
      <div className={`gl-admin-media__container ${className}`}>
        <EmptyState
          icon={emptyState.icon || "media"}
          title={emptyState.title || "No media files yet"}
          description={emptyState.description}
          action={emptyState.action}
        />
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
            <MediaCard media={media} onClick={handleCardClick} />
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
