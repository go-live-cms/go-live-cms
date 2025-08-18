import React from "react";
import { getMediaURL } from "@gl-admin/lib/api";
import type { Media } from "@gl-admin/lib/types";
import "@gl-admin/assets/styles/components/media-card.scss";

interface Props {
  media: Media;
}

function getFileType(mediaPath: string): string {
  const ext = mediaPath.split(".").pop()?.toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext || "")) return "image";
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext || "")) return "video";
  if (["mp3", "wav", "ogg", "m4a"].includes(ext || "")) return "audio";
  if (["pdf"].includes(ext || "")) return "pdf";
  if (["doc", "docx"].includes(ext || "")) return "document";
  return "file";
}

function getFileIcon(mediaPath: string): string {
  const ext = mediaPath.split(".").pop()?.toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext || "")) return "🖼️";
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext || "")) return "🎥";
  if (["mp3", "wav", "ogg", "m4a"].includes(ext || "")) return "🎵";
  if (["pdf"].includes(ext || "")) return "📄";
  if (["doc", "docx"].includes(ext || "")) return "📝";
  return "📁";
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function isImage(mediaPath: string): boolean {
  const ext = mediaPath.split(".").pop()?.toLowerCase();
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext || "");
}

const MediaCard: React.FC<Props> = ({ media }) => {
  const fileType = getFileType(media.media_path);
  const fileIcon = getFileIcon(media.media_path);
  const mediaURL = getMediaURL(media.media_path);
  const fileName = media.name;
  const fileSize = media.file_size ? formatFileSize(media.file_size) : "Unknown size";
  const postCount = media.post_count || 0;

  return (
    <div className="gl-admin-media-card" data-id={media.id}>
      <div className="gl-admin-media-card__thumbnail">
        <div
          className={`gl-admin-media-card__type-badge gl-admin-media-card__type-badge--${fileType}`}
          data-type={fileType}
        >
          {fileType}
        </div>

        {isImage(media.media_path) ? (
          <img
            src={mediaURL}
            alt={media.alt}
            loading="lazy"
            className="gl-admin-media-card__image"
          />
        ) : (
          <div className="gl-admin-media-card__file-icon">{fileIcon}</div>
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
  );
};

export default MediaCard;
