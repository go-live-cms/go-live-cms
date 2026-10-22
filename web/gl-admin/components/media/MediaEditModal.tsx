import React, { useState, useRef } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import GLAdminButton from "@gl-admin/components/ui/Button"
import Icon from "@gl-admin/components/ui/Icon"
import { getMediaURL } from "@gl-admin/lib/api"
import { updateMedia, deleteMedia, getMediaPosts, replaceMediaFile, getMediaPreviewURL } from "@gl-admin/lib/api/media"
import { getPosts } from "@gl-admin/lib/api/posts"
import type { Media } from "@gl-admin/lib/types"
import MediaTypeBadge from "./MediaTypeBadge"
import "@gl-admin/assets/styles/components/media/media-edit-modal.scss"
import Button from "@gl-admin/components/ui/Button"

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
  const [copyButtonText, setCopyButtonText] = useState("Copy URL")
  // null when no replace is running; otherwise the upload fraction (0..1).
  const [replaceProgress, setReplaceProgress] = useState<number | null>(null)
  const [replaceError, setReplaceError] = useState<string | null>(null)

  const fileUrlRef = useRef<HTMLInputElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const isReplacing = replaceProgress !== null

  React.useEffect(() => {
    if (media && isOpen) {
      setEditedData({
        name: media.name || "",
        alt: media.alt || "",
        description: media.description || "",
      })
      setReplaceError(null)

      if (media.post_count && media.post_count > 0) {
        setLoadingPosts(true)
        setTimeout(() => {
          getMediaPosts(media.id).then((response) => {
            setUsedInPosts(response.data)
            setLoadingPosts(false)
          })
        }, 500)
      }
    }
  }, [media, isOpen])

  const makeAbsoluteUrl = (url: string) => {
    if (!url) return ""
    return new URL(url, window.location.origin).href
  }

  const absoluteMediaURL = React.useMemo(() => {
    if (!media) return ""
    const mediaURL = getMediaURL(media.media_path)
    return makeAbsoluteUrl(mediaURL)
  }, [media])

  if (!media) return null

  const mediaURL = getMediaURL(media.media_path)
  const previewURL = getMediaPreviewURL(media)
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
      const updated = await updateMedia(media.id, editedData)
      const saved = updated.media as Media

      setEditedData({
        name: saved.name || "",
        alt: saved.alt || "",
        description: saved.description || "",
      })

      onMediaUpdated?.(saved)

      setIsEditing(false)
    } catch (error) {
      console.error("Failed to update media:", error)
    } finally {
      setIsSaving(false)
    }
  }

  // Replace keeps the id, title, alt text and URL; the server only accepts a
  // file of the same type, so the picker is limited to it and a mismatch is
  // caught here before uploading.
  const handleReplaceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = "" // so picking the same file again still fires onChange
    if (!file) return

    setReplaceError(null)
    if (media.mime_type && file.type && file.type !== media.mime_type) {
      setReplaceError(`The replacement must be a ${fileExtension} file, like the original.`)
      return
    }

    setReplaceProgress(0)
    try {
      const { media: saved } = await replaceMediaFile(media.id, file, setReplaceProgress)
      onMediaUpdated?.({ ...saved, post_count: saved.post_count ?? media.post_count })
    } catch (error) {
      setReplaceError(error instanceof Error ? error.message : "Replace failed")
    } finally {
      setReplaceProgress(null)
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

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(absoluteMediaURL)
      setCopyButtonText("Copied!")
      setTimeout(() => {
        setCopyButtonText("Copy URL")
      }, 2000)
    } catch {
      if (fileUrlRef.current) {
        fileUrlRef.current.value = absoluteMediaURL
        fileUrlRef.current.select()
        document.execCommand("copy")
        setCopyButtonText("Copied!")
        setTimeout(() => {
          setCopyButtonText("Copy URL")
        }, 2000)
      }
    }
  }

  const handleOpenInNewTab = () => {
    window.open(mediaURL, "_blank", "noopener,noreferrer")
  }

  const handleDownload = () => {
    const link = document.createElement("a")
    link.href = absoluteMediaURL
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
            disabled={isSaving || isDeleting || isReplacing}
          >
            <Icon name="trash" color="white" width="14" height="14" />
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
        {isEditing && (
          <GLAdminButton color="white" variation="primary" onClick={handleSave} disabled={isSaving || isDeleting || isReplacing}>
            {isSaving ? "Saving..." : "Save Changes"}
          </GLAdminButton>
        )}

        {!isEditing && (
          <GLAdminButton
            color="white"
            variation="primary"
            onClick={() => setIsEditing(true)}
            disabled={isSaving || isDeleting || isReplacing}
          >
            Edit
          </GLAdminButton>
        )}
        {isEditing && (
          <GLAdminButton color="white" variation="flat" onClick={handleCancel} disabled={isSaving || isDeleting || isReplacing}>
            {isEditing ? "Cancel Changes" : "Close"}
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
                <img src={previewURL} alt={editedData.alt || media.alt} className="media-edit-modal__preview-image" />
              ) : (
                <div className="media-edit-modal__preview-file">
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

            <div className="media-edit-modal__replace">
              <input
                ref={replaceInputRef}
                type="file"
                accept={media.mime_type || undefined}
                className="media-edit-modal__replace-input"
                onChange={handleReplaceFile}
                aria-label="Replacement file"
                hidden
              />
              <GLAdminButton
                variation="flat"
                onClick={() => replaceInputRef.current?.click()}
                disabled={isSaving || isDeleting || isReplacing}
              >
                {isReplacing ? "Uploading..." : "Replace file"}
              </GLAdminButton>
              <span className="media-edit-modal__replace-hint">
                Same type ({fileExtension}). Keeps the URL, title and alt text, so posts using it show the new file.
              </span>
              {isReplacing && (
                <progress
                  className="media-edit-modal__replace-progress"
                  value={replaceProgress ?? 0}
                  max={1}
                  aria-label="Upload progress"
                />
              )}
              {replaceError && (
                <div className="media-edit-modal__replace-error" role="alert">
                  {replaceError}
                </div>
              )}
            </div>
          </div>

          <div className="media-edit-modal__details">
            <div className="media-edit-modal__field-group">
              <div className="media-edit-modal__field">
                <MediaTypeBadge mediaPath={media.media_path} className="media-edit-modal__type-badge" />
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
                  <span className="media-edit-modal__value">{editedData.name || media.name}</span>
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
                  <span className="media-edit-modal__value">{editedData.alt || "No alt text"}</span>
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
                  <span className="media-edit-modal__value">{editedData.description}</span>
                )}
              </div>
            </div>

            <div className="media-edit-modal__field-group">
              <div className="media-edit-modal__field">
                <label className="media-edit-modal__label" htmlFor="media-url">
                  File URL:
                </label>
                <input
                  id="media-url"
                  ref={fileUrlRef}
                  type="text"
                  className="media-edit-modal__input media-edit-modal__input--readonly"
                  value={absoluteMediaURL}
                  readOnly
                />
                <div className="media-edit-modal__url-container">
                  <div className="media-edit-modal__url-actions">
                    {/* TODO : implement button sizes */}
                    <Button onClick={handleCopyUrl} title="Copy to clipboard">
                      <Icon name="copy" width="16" height="16" color="black" /> {copyButtonText}
                    </Button>
                    <div className="media-edit-modal__url-btn" onClick={handleOpenInNewTab} title="Open in new tab">
                      <Icon name="external-link" width="16" height="16" />
                    </div>
                    <div className="media-edit-modal__url-btn" onClick={handleDownload} title="Download">
                      <Icon name="download" width="16" height="16" />
                    </div>
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
