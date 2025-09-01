import React, { useState, useRef } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import GLAdminButton from "@gl-admin/components/ui/Button"
import Icon from "@gl-admin/components/ui/Icon"
import { getMediaURL } from "@gl-admin/lib/api"
import { updateMedia, deleteMedia, getMediaPosts } from "@gl-admin/lib/api/media"
import { getPosts } from "@gl-admin/lib/api/posts"
import type { Media } from "@gl-admin/lib/types"

interface MediaEditModalProps {
  isOpen: boolean
  onClose: () => void
  media: Media | null
  onMediaUpdated?: (updatedMedia: Media) => void
  onMediaDeleted?: (mediaId: number) => void
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
}

function getFileType(mediaPath: string): string {
  const ext = mediaPath.split(".").pop()?.toLowerCase() || ""

  if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext)) return "image"
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return "video"
  if (["mp3", "wav", "ogg", "m4a"].includes(ext)) return "audio"
  if (["pdf", "doc", "docx"].includes(ext)) return "document"
  if (["svg"].includes(ext)) return "graphic"
  if (["txt"].includes(ext)) return "text"

  return "file"
}

function getFileExtension(mediaPath: string): string {
  return mediaPath.split(".").pop()?.toUpperCase() || "UNKNOWN"
}

function isImage(mediaPath: string): boolean {
  const ext = mediaPath.split(".").pop()?.toLowerCase() || ""
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext)
}

const MediaEditModal: React.FC<MediaEditModalProps> = ({ isOpen, onClose, media, onMediaUpdated, onMediaDeleted }) => {
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [editedData, setEditedData] = useState({
    name: "",
    alt: "",
    description: "",
  })
  const [usedInPosts, setUsedInPosts] = useState<any[]>([])
  const [loadingPosts, setLoadingPosts] = useState(false)

  const fileUrlRef = useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (media && isOpen) {
      setEditedData({
        name: media.name || "",
        alt: media.alt || "",
        description: media.description || "",
      })

      if (media.post_count && media.post_count > 0) {
        setLoadingPosts(true)
        setTimeout(() => {
          getMediaPosts(media.id).then((response) => {
            setUsedInPosts(response.data)
            setLoadingPosts(false)
            console.log("Fetched posts using media:", response.data)
          })
        }, 500)
      }
    }
  }, [media, isOpen])

  if (!media) return null

  const mediaURL = getMediaURL(media.media_path)
  const fileType = getFileType(media.media_path)
  const fileExtension = getFileExtension(media.media_path)
  const fileSize = formatFileSize(media.file_size || 0)
  const isImageFile = isImage(media.media_path)

  const handleInputChange = (field: string, value: string) => {
    setEditedData((prev) => ({
      ...prev,
      [field]: value,
    }))
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const updatedMedia = await updateMedia(media.id, editedData)
      if (onMediaUpdated) {
        onMediaUpdated(updatedMedia.media)
      }
      setIsEditing(false)
    } catch (error) {
      console.error("Failed to update media:", error)
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await deleteMedia(media.id)
      if (onMediaDeleted) {
        onMediaDeleted(media.id)
      }
      onClose()
    } catch (error) {
      console.error("Failed to delete media:", error)
    } finally {
      setIsDeleting(false)
      setShowDeleteConfirm(false)
    }
  }

  const handleCopyUrl = () => {
    if (fileUrlRef.current) {
      fileUrlRef.current.select()
      document.execCommand("copy")
    }
  }

  const handleOpenInNewTab = () => {
    window.open(mediaURL, "_blank")
  }

  const handleDownload = () => {
    const link = document.createElement("a")
    link.href = mediaURL
    link.download = media.name || "download"
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleCancel = () => {
    if (isEditing) {
      setEditedData({
        name: media.name || "",
        alt: media.alt || "",
        description: media.description || "",
      })
      setIsEditing(false)
    } else {
      onClose()
    }
  }

  const footer = (
    <div className="media-edit-modal__footer">
      <div className="media-edit-modal__footer-left">
        {!showDeleteConfirm ? (
          <GLAdminButton
            variation="danger"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={isSaving || isDeleting}
          >
            <Icon name="delete" color="white" width="14" height="14" />
            Delete Permanently
          </GLAdminButton>
        ) : (
          <div className="media-edit-modal__delete-confirm">
            <span>Are you sure?</span>
            <GLAdminButton variation="danger" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? "Deleting..." : "Yes, Delete"}
            </GLAdminButton>
            <GLAdminButton variation="flat" onClick={() => setShowDeleteConfirm(false)} disabled={isDeleting}>
              Cancel
            </GLAdminButton>
          </div>
        )}
      </div>

      <div className="media-edit-modal__footer-right">
        <GLAdminButton variation="flat" onClick={handleCancel} disabled={isSaving || isDeleting}>
          {isEditing ? "Cancel Changes" : "Close"}
        </GLAdminButton>

        {isEditing && (
          <GLAdminButton variation="primary" onClick={handleSave} disabled={isSaving || isDeleting}>
            {isSaving ? "Saving..." : "Save Changes"}
          </GLAdminButton>
        )}

        {!isEditing && (
          <GLAdminButton variation="primary" onClick={() => setIsEditing(true)} disabled={isSaving || isDeleting}>
            <Icon name="edit" color="white" width="14" height="14" />
            Edit
          </GLAdminButton>
        )}
      </div>
    </div>
  )

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Media Details: ${media.name}`}
      size="large"
      footer={footer}
      showHeader={false}
    >
      <div className="media-edit-modal">
        <div className="media-edit-modal__content">
          <div className="media-edit-modal__preview">
            <div className="media-edit-modal__preview-container">
              {isImageFile ? (
                <img src={mediaURL} alt={media.alt} className="media-edit-modal__preview-image" />
              ) : (
                <div className="media-edit-modal__preview-file">
                  <Icon name={`file-${fileType}`} width="80" height="80" />
                  <span className="media-edit-modal__preview-filename">{media.name}</span>
                </div>
              )}
            </div>

            <div className="media-edit-modal__file-info">
              {media.width && media.height && (
                <div className="media-edit-modal__info-row">
                  <span className="media-edit-modal__info-label">Dimensions:</span>
                  <span className="media-edit-modal__info-value">
                    {media.width} × {media.height} px
                  </span>
                </div>
              )}

              <div className="media-edit-modal__info-row">
                <span className="media-edit-modal__info-label">File Extension:</span>
                <span className="media-edit-modal__info-value">{fileExtension}</span>
              </div>

              <div className="media-edit-modal__info-row">
                <span className="media-edit-modal__info-label">Size:</span>
                <span className="media-edit-modal__info-value">{fileSize}</span>
              </div>
            </div>
          </div>

          <div className="media-edit-modal__details">
            <div className="media-edit-modal__field-group">
              <div className="media-edit-modal__field">
                <label className="media-edit-modal__label">Type:</label>
                <span className="media-edit-modal__value media-edit-modal__value--type">
                  {fileType.charAt(0).toUpperCase() + fileType.slice(1)}
                </span>
              </div>
            </div>

            <div className="media-edit-modal__field-group">
              <div className="media-edit-modal__field">
                <label className="media-edit-modal__label" htmlFor="media-title">
                  Title:
                </label>
                {isEditing ? (
                  <input
                    id="media-title"
                    type="text"
                    className="media-edit-modal__input"
                    value={editedData.name}
                    onChange={(e) => handleInputChange("name", e.target.value)}
                  />
                ) : (
                  <span className="media-edit-modal__value">{media.name}</span>
                )}
              </div>
            </div>

            <div className="media-edit-modal__field-group">
              <div className="media-edit-modal__field">
                <label className="media-edit-modal__label" htmlFor="media-alt">
                  Alt Text:
                </label>
                {isEditing ? (
                  <input
                    id="media-alt"
                    type="text"
                    className="media-edit-modal__input"
                    value={editedData.alt}
                    onChange={(e) => handleInputChange("alt", e.target.value)}
                  />
                ) : (
                  <span className="media-edit-modal__value">{media.alt || "No alt text"}</span>
                )}
              </div>
            </div>

            <div className="media-edit-modal__field-group">
              <div className="media-edit-modal__field">
                <label className="media-edit-modal__label" htmlFor="media-description">
                  Description:
                </label>
                {isEditing ? (
                  <textarea
                    id="media-description"
                    className="media-edit-modal__textarea"
                    value={editedData.description}
                    onChange={(e) => handleInputChange("description", e.target.value)}
                    rows={3}
                  />
                ) : (
                  <span className="media-edit-modal__value">{media.description}</span>
                )}
              </div>
            </div>

            <div className="media-edit-modal__field-group">
              <div className="media-edit-modal__field">
                <label className="media-edit-modal__label" htmlFor="media-url">
                  File URL:
                </label>
                <div className="media-edit-modal__url-container">
                  <input
                    id="media-url"
                    ref={fileUrlRef}
                    type="text"
                    className="media-edit-modal__input media-edit-modal__input--readonly"
                    value={mediaURL}
                    readOnly
                  />
                  <div className="media-edit-modal__url-actions">
                    <button className="media-edit-modal__url-btn" onClick={handleCopyUrl} title="Copy to clipboard">
                      <Icon name="copy" width="16" height="16" />
                    </button>
                    <button className="media-edit-modal__url-btn" onClick={handleOpenInNewTab} title="Open in new tab">
                      <Icon name="external-link" width="16" height="16" />
                    </button>
                    <button className="media-edit-modal__url-btn" onClick={handleDownload} title="Download">
                      <Icon name="download" width="16" height="16" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="media-edit-modal__field-group">
              <div className="media-edit-modal__field">
                <label className="media-edit-modal__label">Used in:</label>
                <span className="media-edit-modal__value">
                  {media.post_count || 0} {(media.post_count || 0) === 1 ? "post" : "posts"}
                </span>
              </div>

              {(media.post_count || 0) > 0 && (
                <div className="media-edit-modal__posts-list">
                  {loadingPosts ? (
                    <div className="media-edit-modal__posts-loading">Loading posts...</div>
                  ) : (
                    <ul className="media-edit-modal__posts">
                      {usedInPosts.map(({ post, media_order }) => (
                        <li key={`${post.id}-${media_order}`} className="media-edit-modal__post-item">
                          <a
                            href={`/admin/posts/${post.id}`}
                            className="media-edit-modal__post-link"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {post.title}
                          </a>
                          <span
                            className={`media-edit-modal__post-status media-edit-modal__post-status--${
                              // TODO: add post status and post type to posts response
                              (post as any).post_status ?? (post as any).status ?? "unknown"
                            }`}
                          >
                            {(post as any).post_status ?? (post as any).status ?? "unknown"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export default MediaEditModal
