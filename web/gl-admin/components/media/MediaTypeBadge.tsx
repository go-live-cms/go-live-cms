import React from "react"
import "@gl-admin/assets/styles/components/media/media-type-badge.scss"

export type MediaKind = "image" | "video" | "audio" | "pdf" | "document" | "file"

export function getFileType(mediaPath: string): MediaKind {
  const ext = mediaPath.split(".").pop()?.toLowerCase() || ""
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext)) return "image"
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return "video"
  if (["mp3", "wav", "ogg", "m4a"].includes(ext)) return "audio"
  if (["pdf"].includes(ext)) return "pdf"
  if (["doc", "docx"].includes(ext)) return "document"
  return "file"
}

interface MediaTypeBadgeProps {
  mediaPath: string
  className?: string
  baseClassName?: string
  showIcon?: boolean
  labelOverride?: string
}

const MediaTypeBadge: React.FC<MediaTypeBadgeProps> = ({
  mediaPath,
  className = "",
  baseClassName = "gl-admin-media-type-badge",
  showIcon = false,
  labelOverride,
}) => {
  const type = getFileType(mediaPath)

  const classes = [baseClassName, `${baseClassName}--${type}`, className].filter(Boolean).join(" ")

  return (
    <div className={classes} data-type={type} title={labelOverride ?? type}>
      <span className={`${baseClassName}__label`}>{labelOverride ?? type}</span>
    </div>
  )
}

export default MediaTypeBadge
