import React from "react"
import { getMediaURL } from "@gl-admin/lib/api"
import type { Media } from "@gl-admin/lib/types"
import "@gl-admin/assets/styles/components/media/media-card.scss"
import MediaTypeBadge from "@gl-admin/components/media/MediaTypeBadge"

interface Props {
  media: Media
  onClick?: (media: Media) => void
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
}

function isImage(mediaPath: string): boolean {
  const ext = mediaPath.split(".").pop()?.toLowerCase()
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext || "")
}

const MediaCard: React.FC<Props> = ({ media, onClick }) => {
  const mediaURL = getMediaURL(media.media_path)
  const fileName = media.name
  const fileSize = media.file_size ? formatFileSize(media.file_size) : "Unknown size"
  const postCount = media.post_count || 0

  const handleClick = () => {
    if (onClick) {
      onClick(media)
    }
  }

  return (
    <div
      className="gl-admin-media-card"
      data-id={media.id}
      onClick={handleClick}
      style={{ cursor: onClick ? "pointer" : "default" }}
    >
      <div className="gl-admin-media-card__thumbnail">
        <MediaTypeBadge mediaPath={media.media_path} className="gl-admin-media-card__type-badge" showIcon />

        {isImage(media.media_path) ? (
          <img src={mediaURL} alt={media.alt} loading="lazy" className="gl-admin-media-card__image" />
        ) : (
          <div className="gl-admin-media-card__file-icon"></div>
        )}
      </div>

      <div className="gl-admin-media-card__content">
        <h4 className="gl-admin-media-card__title" title={fileName}>
          {fileName}
        </h4>

        <div className="gl-admin-media-card__meta">
          <span className="gl-admin-media-card__size">{fileSize}</span>
          {postCount > 0 && (
            <span className="gl-admin-media-card__posts">
              {postCount} {postCount === 1 ? "post" : "posts"}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export default MediaCard
