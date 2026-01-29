import React, { useEffect, useRef, useState } from "react"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import MediaGrid from "@gl-admin/components/media/MediaGrid"
import { getMedia, createMedia } from "@gl-admin/lib/api/media"
import { getUsers } from "@gl-admin/lib/api/users"
import { getMediaURL } from "@gl-admin/lib/api"
import type { Media, User, MediaSortOption } from "@gl-admin/lib/types"
import GLAdminButton from "@gl-admin/components/ui/Button"
import Icon from "@gl-admin/components/ui/Icon"
import MediaEditModal from "@gl-admin/components/media/MediaEditModal"
import FilterSelect from "@gl-admin/components/ui/FilterSelect"
import Button from "@gl-admin/components/ui/Button"

//import { initializeMediaCardHandlers } from "@gl-admin/scripts/media-card-handlers"
import "@gl-admin/assets/styles/pages/media.scss"

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
}

const Media: React.FC = () => {
  const { baseTitle, isDark } = useGoLive()
  const [mediaItems, setMediaItems] = useState<Media[]>([])
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState<number>(0)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<
    { name: string; size: number; progress: number; status: string; error?: boolean }[]
  >([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [bulkSelectMode, setBulkSelectMode] = useState(false)
  const [selectedMedia, setSelectedMedia] = useState<Media[]>([])
  const [loading, setLoading] = useState(false)
  const [currentPage, setCurrentPage] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [itemsPerPage] = useState(12)

  const [searchQuery, setSearchQuery] = useState("")
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [selectedMediaForEdit, setSelectedMediaForEdit] = useState<Media | null>(null)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [selectedFilters, setSelectedFilters] = useState<Record<string, string>>({ user_id: "", type: "", sort: "" })
  const [authorOptions, setAuthorOptions] = useState<{ label: string; value: string }[]>([
    { label: "All authors", value: "" },
  ])
  const iconColor = isDark ? "#000000" : "#FFFFFF"

  useEffect(() => {

    document.title = `${baseTitle} Media`;
    refreshMediaData()
    getAuthorOptions().then(setAuthorOptions)
    //initializeMediaCardHandlers()
  }, [])

  const getAuthorOptions = async () => {
    const authors = await getAuthors();
    const authorOptions =
      authors?.map((author) => ({
        label: author.full_name || author.username,
        value: String(author.id),
      })) || []
    return [{ label: "All authors", value: "" }, ...authorOptions]
  }

  const getAuthors = async () => {
    try {
      setLoadingUsers(true)
      const response = await getUsers()
      return response.data
    } catch (e) {
      console.error("Error loading users:", e)
    } finally {
      setLoadingUsers(false)
    }
    return []
  }

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value)
  }

  const handleFilterSearch = () => {
    refreshMediaData(true)
  }

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (searchQuery !== "") {
        refreshMediaData(true)
      }
    }, 600)
    return () => clearTimeout(timeoutId)
  }, [searchQuery, selectedFilters])

  const handleBulkSelectToggle = () => {
    setBulkSelectMode(!bulkSelectMode)
    setSelectedMedia([])
  }

  const handleMediaSelect = (media: Media) => {
    if (selectedMedia.some((selected) => selected.id === media.id)) {
      setSelectedMedia(selectedMedia.filter((selected) => selected.id !== media.id))
    } else {
      setSelectedMedia([...selectedMedia, media])
    }
  }

  const handleFileUpload = async (files: File[]) => {
    setUploading(true)
    setUploadProgress([])
    const progressArr: typeof uploadProgress = []

    for (const file of files) {
      progressArr.push({ name: file.name, size: file.size, progress: 0, status: "Uploading..." })
    }
    setUploadProgress([...progressArr])

    const uploadPromises = files.map((file, idx) => uploadSingleFile(file, idx))
    const results = await Promise.allSettled(uploadPromises)

    const successCount = results.filter((r) => r.status === "fulfilled" && r.value).length
    const failCount = results.length - successCount

    setTimeout(async () => {
      if (successCount > 0) {
        showToast(
          `Successfully uploaded ${successCount} file${successCount !== 1 ? "s" : ""}${failCount > 0 ? `, ${failCount} failed` : ""
          }`,
          "success"
        )
        await refreshMediaData(true)
      } else {
        showToast("All uploads failed", "error")
      }
      setUploading(false)
    }, 1000)
  }

  const refreshMediaData = async (reset: boolean = true) => {
    try {
      if (reset) {
        setLoading(true)
        setCurrentPage(0)
      }

      const offset = reset ? 0 : (currentPage + 1) * itemsPerPage
      const response = await getMedia({
        limit: itemsPerPage,
        offset: offset,
        search: searchQuery || undefined,
        type: selectedFilters.type || undefined,
        user_id: selectedFilters.user_id ? parseInt(selectedFilters.user_id) : undefined,
        sort: selectedFilters.sort as MediaSortOption || undefined,
      })

      if (reset) {
        setMediaItems(response.data)
        setCurrentPage(0)
      } else {
        setMediaItems((prev) => [...prev, ...response.data])
        setCurrentPage((prev) => prev + 1)
      }

      const totalItems = response.meta?.total ?? 0
      const currentOffset = offset + response.data.length

      setTotal(totalItems)
      setHasMore(response.data.length === itemsPerPage && currentOffset < totalItems)

      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch media")
      console.error("Error fetching media:", e)
    } finally {
      setLoading(false)
    }
  }

  const loadMoreMedia = async () => {
    if (loadingMore || !hasMore) return

    try {
      setLoadingMore(true)
      const offset = (currentPage + 1) * itemsPerPage
      const response = await getMedia({
        limit: itemsPerPage,
        offset: offset,
        search: searchQuery || undefined,
        type: selectedFilters.type || undefined,
        user_id: selectedFilters.user_id ? parseInt(selectedFilters.user_id) : undefined,
        sort: selectedFilters.sort as MediaSortOption || undefined,
      })

      setMediaItems((prev) => [...prev, ...response.data])
      setCurrentPage((prev) => prev + 1)

      const totalItems = response.meta?.total ?? 0
      const currentOffset = offset + response.data.length

      setHasMore(response.data.length === itemsPerPage && currentOffset < totalItems)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more media")
      console.error("Error loading more media:", e)
    } finally {
      setLoadingMore(false)
    }
  }

  const uploadSingleFile = async (file: File, idx: number): Promise<boolean> => {
    try {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("name", file.name)
      formData.append("description", `Uploaded file: ${file.name}`)
      formData.append("alt", file.name.split(".")[0])

      await createMedia(formData)

      let progress = 0
      const interval = setInterval(() => {
        progress += Math.random() * 20
        if (progress > 90) progress = 90
        setUploadProgress((prev) => {
          const copy = [...prev]
          copy[idx] = { ...copy[idx], progress, status: `${Math.round(progress)}%` }
          return copy
        })
      }, 100)

      await new Promise((resolve) => setTimeout(resolve, 500))
      clearInterval(interval)

      setUploadProgress((prev) => {
        const copy = [...prev]
        copy[idx] = { ...copy[idx], progress: 100, status: "Complete" }
        return copy
      })

      return true
    } catch (error) {
      console.error("Upload error:", error)
      setUploadProgress((prev) => {
        const copy = [...prev]
        copy[idx] = { ...copy[idx], status: "Failed", error: true }
        return copy
      })
      return false
    }
  }

  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null)
  const showToast = (message: string, type: "success" | "error" | "info" = "info") => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 4700)
  }

  const [showUploadArea, setShowUploadArea] = useState(false)
  const [uploadAreaActive, setUploadAreaActive] = useState(false)

  const handleNewMediaClick = () => {
    setShowUploadArea(true)
    setTimeout(() => setUploadAreaActive(true), 10)
  }

  const handleCancelUploadClick = () => {
    setUploadAreaActive(false)
    setTimeout(() => {
      setShowUploadArea(false)
      setUploading(false)
      setUploadProgress([])
      if (fileInputRef.current) fileInputRef.current.value = ""
    }, 400)
  }

  const handleUploadBtnClick = () => fileInputRef.current?.click()

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files)
      if (files.length > 0) handleFileUpload(files)
    }
  }

  const uploadAreaRef = useRef<HTMLDivElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(true)
  }
  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
  }
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) handleFileUpload(files)
  }

  const handleMediaCardClick = (media: Media) => {
    setSelectedMediaForEdit(media)
    setIsEditModalOpen(true)
  }

  const handleCloseEditModal = () => {
    setIsEditModalOpen(false)
    setSelectedMediaForEdit(null)
  }
  const handleMediaUpdated = (updatedMedia: Media) => {
    setMediaItems((prev) => prev.map((item) => (item.id === updatedMedia.id ? updatedMedia : item)))
  }

  const handleMediaDeleted = (mediaId: number) => {
    setMediaItems((prev) => prev.filter((item) => item.id !== mediaId))
    setTotal((prev) => prev - 1)
  }

  const clearFilters = () => {
    setSelectedFilters({ user_id: "", type: "", sort: "" })
  }

  const filters = (
    <>
      {selectedFilters.user_id ? (
        <div className="gl-clear-filters" onClick={clearFilters}>
          Clear filters
        </div>
      ) : null}
      <FilterSelect
        options={authorOptions}
        prefix="Author:"
        value={selectedFilters.user_id}
        loading={loadingUsers}
        onChange={(value) => setSelectedFilters({ ...selectedFilters, user_id: value })}
      />
      <FilterSelect
        options={[
          { label: "All types", value: "" },
          { label: "Image", value: "image" },
          { label: "Video", value: "video" },
          { label: "Audio", value: "audio" },
          { label: "Document", value: "document" },
        ]}
        prefix="View:"
        value={selectedFilters.type}
        onChange={(value) => setSelectedFilters({ ...selectedFilters, type: value })}
      />
      <FilterSelect
        options={[
          { label: "Default", value: "" },
          { label: "Newest First", value: "date_desc" },
          { label: "Oldest First", value: "date_asc" },
          { label: "Name A-Z", value: "title_asc" },
          { label: "Name Z-A", value: "title_desc" },
          { label: "Type A-Z", value: "type_asc" },
          { label: "Type Z-A", value: "type_desc" },
          { label: "Smallest First", value: "size_asc" },
          { label: "Largest First", value: "size_desc" },
        ]}
        value={selectedFilters.sort}
        onChange={(value) => setSelectedFilters({ ...selectedFilters, sort: value })}
        prefix="Sort by:"
      />
      <Button
        className="gl-admin-media__bulk-select"
        variation={bulkSelectMode ? "primary" : "flat"}
        onClick={handleBulkSelectToggle}
      >
        <Icon name="bulkSelectIcon" color={bulkSelectMode ? "white" : "#333536"} width="14" height="14" />
        {bulkSelectMode ? "Exit Select" : "Bulk Select"}
      </Button>
      <Button onClick={handleNewMediaClick} className="gl-admin-media__new-media-btn">
        <Icon name="add" color={iconColor} width="14" height="14" /> New Media
      </Button>
    </>
  )

  return (
    <>
      <div className="gl-admin-media-library">
        <div className="admin-topbar">
          <h1>Media Library</h1>
          <div className="admin-topbar__actions">
            {filters}
          </div>
        </div>

        {/* TODO: add this later, its working
        <div className="gl-admin-media-header__search">
          <input
            type="text"
            placeholder="Search media..."
            value={searchQuery}
            onChange={handleSearchChange}
            className="gl-admin-media-header__search-input"
          />
          <button onClick={handleFilterSearch} className="gl-admin-media-header__search-btn" disabled={loading}>
            <Icon name="search" color="white" width="16" height="16" />
          </button>
        </div> */}

        {showUploadArea && (
          <div
            className={`gl-admin-media__upload-area${uploadAreaActive ? " gl-admin-media__upload-area--active" : ""}${dragOver ? " gl-admin-media__upload-area--dragover" : ""
              }`}
            ref={uploadAreaRef}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="gl-admin-media__upload-area-header">
              <h3>Drop files to upload</h3>
              <div>
                <span>or</span>
                <div className="gl-admin-media__upload-area-button-wrapper">
                  <Button className="gl-admin-media__upload-btn" onClick={handleUploadBtnClick}>
                    <Icon name="uploadIcon" color={iconColor} width="14" height="14" /> Upload Files
                  </Button>
                  <Button
                    className="gl-admin-media__cancel-upload-btn"
                    variation="flat"
                    onClick={handleCancelUploadClick}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
              <small>
                Maximum size: 50MB. Supported: Images, Videos, Audio, Documents
                {/* TODO:import number from env size limit */}
              </small>
            </div>
            <input
              type="file"
              ref={fileInputRef}
              multiple
              accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt"
              style={{ display: "none" }}
              onChange={handleFileInputChange}
            />
          </div>
        )}

        {uploading && (
          <div className="gl-admin-media__upload-progress">
            {uploadProgress.map((item, idx) => (
              <div className="gl-admin-media__progress-item" key={idx}>
                <div className="gl-admin-media__progress-info">
                  <span className="gl-admin-media__file-name">{item.name}</span>
                  <span className="gl-admin-media__file-size">{formatFileSize(item.size)}</span>
                </div>
                <div className="gl-admin-media__progress-bar">
                  <div
                    className={`gl-admin-media__progress-fill${item.error
                      ? " gl-admin-media__progress-fill--error"
                      : item.progress === 100
                        ? " gl-admin-media__progress-fill--success"
                        : ""
                      }`}
                    style={{ width: `${item.progress}%` }}
                  ></div>
                </div>
                <span
                  className={`gl-admin-media__progress-status${item.error
                    ? " gl-admin-media__progress-status--error"
                    : item.progress === 100
                      ? " gl-admin-media__progress-status--success"
                      : ""
                    }`}
                >
                  {item.status}
                </span>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="error-message">
            <strong>Error:</strong> {error}
          </div>
        )}

        <MediaGrid
          mediaItems={mediaItems}
          loading={loading}
          error={error}
          selectable={bulkSelectMode}
          selectedMedia={selectedMedia}
          onMediaSelect={handleMediaSelect}
          onMediaClick={handleMediaCardClick}
          emptyState={{
            title: "No media files yet",
            description: 'Upload your first file by clicking "New Media" above',
          }}
        />

        {!loading && !error && mediaItems.length > 0 && (
          <div className="gl-admin-media__load-more-section">
            <div className="gl-admin-media__pagination-info">
              Showing {mediaItems.length} of {total} items
            </div>

            {hasMore && (
              <GLAdminButton
                className="gl-admin-media__load-more-btn"
                variation="primary"
                onClick={loadMoreMedia}
                disabled={loadingMore}
              >
                {loadingMore ? <>Loading more...</> : <>Load More</>}
              </GLAdminButton>
            )}

            {!hasMore && mediaItems.length < total && (
              <p className="gl-admin-media__end-message">You've reached the end of the media library</p>
            )}
          </div>
        )}

        {toast && <div className={`toast toast--${toast.type}`}>{toast.message}</div>}

        <MediaEditModal
          isOpen={isEditModalOpen}
          onClose={handleCloseEditModal}
          media={selectedMediaForEdit}
          onMediaUpdated={(updated) => {
            setMediaItems((prevItems) => prevItems.map((item) => (item.id === updated.id ? updated : item)))
            setSelectedMediaForEdit(updated)
          }}
          onMediaDeleted={(id) => {
            setMediaItems((prev) => prev.filter((m) => m.id !== id))
            setSelectedMediaForEdit(null)
            setIsEditModalOpen(false)
          }}
        />
      </div >
    </>
  )
}

export default Media
