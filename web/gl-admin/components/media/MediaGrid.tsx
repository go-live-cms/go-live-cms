import React from "react"
import MediaCard from "./MediaCard"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import Button from "@gl-admin/components/ui/Button"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import { UploadIcon } from "@gl-admin/components/ui/icons"
import type { Media } from "@gl-admin/lib/types"

// A file being uploaded, shown as the first tiles of the grid.
export interface UploadingFile {
  key: string
  name: string
  // null while uploading; the readable reason when it failed.
  error: string | null
}

interface MediaGridProps {
  mediaItems: Media[]
  loading?: boolean
  // A readable message (see errorMessage in lib/api/errors.ts).
  error?: string | null
  onRetry?: () => void
  // Shown in place of the grid when there are no items (and nothing uploading).
  empty?: React.ReactNode
  uploads?: UploadingFile[]
  className?: string
  // Select mode: clicks toggle selection instead of opening.
  selectable?: boolean
  selectedMedia?: Media[]
  onMediaSelect?: (media: Media) => void
  // The item open in the side panel (its tile is pressed).
  activeId?: number | null
  onMediaClick?: (media: Media) => void
}

// The skeleton tiles' name widths (the "Media · loading" board).
const SKELETON_WIDTHS = ["80%", "64%", "72%", "58%", "76%", "60%", "70%", "66%", "80%", "54%", "74%", "62%"]

const MediaGrid: React.FC<MediaGridProps> = ({
  mediaItems,
  loading = false,
  error = null,
  onRetry,
  empty,
  uploads = [],
  className = "",
  selectable = false,
  selectedMedia = [],
  onMediaSelect,
  activeId = null,
  onMediaClick,
}) => {
  if (loading) {
    return (
      <div className={`gl-media-grid-wrap ${className}`}>
        <div className="gl-media-grid" aria-busy="true" aria-label="Loading media" data-testid="media-grid-loading">
          {SKELETON_WIDTHS.map((width, index) => (
            <div key={index} className="gl-media-tile gl-media-tile--skeleton">
              <Skeleton className="gl-media-tile__thumb" />
              <span className="gl-media-tile__text">
                <Skeleton shape="text" width={width} />
                <Skeleton width="50%" height={8} />
              </span>
            </div>
          ))}
        </div>
        <span role="status" className="gl-media-sr">
          Loading media…
        </span>
      </div>
    )
  }

  if (error) {
    return (
      <div className={`gl-media-grid-wrap ${className}`}>
        <EmptyState
          variant="error"
          icon="close"
          title="Couldn't load media"
          description={error}
          action={
            onRetry && (
              <Button variant="primary" onClick={onRetry}>
                Try again
              </Button>
            )
          }
        />
      </div>
    )
  }

  if (mediaItems.length === 0 && uploads.length === 0) {
    return <div className={`gl-media-grid-wrap ${className}`}>{empty ?? <EmptyState icon="media" title="No media yet" />}</div>
  }

  const isSelected = (media: Media) => selectedMedia.some((selected) => selected.id === media.id)

  return (
    <div className={`gl-media-grid-wrap ${className}`}>
      <ul className="gl-media-grid" aria-label="Media files">
        {uploads.map((upload) => (
          <li key={upload.key}>
            <div className={`gl-media-tile gl-media-tile--upload${upload.error ? " is-failed" : ""}`}>
              <span className="gl-media-tile__thumb">
                <UploadIcon size={20} />
                {!upload.error && (
                  <span className="gl-media-tile__progress" role="progressbar" aria-label={`Uploading ${upload.name}`}>
                    <span />
                  </span>
                )}
              </span>
              <span className="gl-media-tile__text">
                <span className="gl-media-tile__name" title={upload.name}>
                  {upload.name}
                </span>
                <span className="gl-media-tile__meta">{upload.error ? `Failed · ${upload.error}` : "Uploading…"}</span>
              </span>
            </div>
          </li>
        ))}
        {mediaItems.map((media) => (
          <li key={media.id}>
            <MediaCard
              // A replaced file gets a fresh tile (and a fresh try at its thumbnail).
              key={media.changed_at}
              media={media}
              selectable={selectable}
              pressed={selectable ? isSelected(media) : media.id === activeId}
              onClick={selectable ? onMediaSelect : onMediaClick}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

export default MediaGrid
