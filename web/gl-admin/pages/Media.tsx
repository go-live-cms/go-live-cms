import React, { useEffect, useRef, useState } from "react"
import MediaGrid from "@gl-admin/components/media/MediaGrid"
import { getMedia, createMedia } from "@gl-admin/lib/api/media"
import { getUsers } from "@gl-admin/lib/api/users"
import { getMediaURL } from "@gl-admin/lib/api"
import type { Media, User, MediaSortOption } from "@gl-admin/lib/types"
import GLAdminButton from "@gl-admin/components/ui/Button"
import Icon from "@gl-admin/components/ui/Icon"

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
  const [selectedType, setSelectedType] = useState("")
  const [selectedUser, setSelectedUser] = useState("")
  const [sortBy, setSortBy] = useState<MediaSortOption>("date_desc")
  const [users, setUsers] = useState<User[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)

  useEffect(() => {
    refreshMediaData()
    loadUsersWithMedia()
    //initializeMediaCardHandlers()
  }, [])

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value)
  }

  const handleTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedType(e.target.value)
  }

  const handleUserChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedUser(e.target.value)
  }

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSortBy(e.target.value as MediaSortOption)
  }

  const handleFilterSearch = () => {
    refreshMediaData(true)
  }

  // deprecated for now, TODO: add a clear filters button
  const handleClearFilters = () => {
    setSearchQuery("")
    setSelectedType("")
    setSelectedUser("")
    setSortBy("date_desc")
    refreshMediaData(true)
  }

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      refreshMediaData(true)
    }, 500)
    return () => clearTimeout(timeoutId)
  }, [selectedType, selectedUser, sortBy])

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (searchQuery !== "") {
        refreshMediaData(true)
      }
    }, 800)
    return () => clearTimeout(timeoutId)
  }, [searchQuery])

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

  const loadUsersWithMedia = async () => {
    try {
      setLoadingUsers(true)
      const response = await getUsers()
      // TODO: This could be optimized with a backend endpoint that only returns users with media
      setUsers(response.data)
    } catch (e) {
      console.error("Error loading users:", e)
    } finally {
      setLoadingUsers(false)
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
        type: selectedType || undefined,
        user_id: selectedUser ? parseInt(selectedUser) : undefined,
        sort: sortBy,
      })

      if (reset) {
        setMediaItems(response.data)
        setCurrentPage(0)
      } else {
        setMediaItems((prev) => [...prev, ...response.data])
        setCurrentPage((prev) => prev + 1)
      }

      setTotal(response.meta.total || 0)
      setHasMore(response.data.length === itemsPerPage && offset + response.data.length < (response.meta.total || 0))
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
        type: selectedType || undefined,
        user_id: selectedUser ? parseInt(selectedUser) : undefined,
        sort: sortBy,
      })

      setMediaItems((prev) => [...prev, ...response.data])
      setCurrentPage((prev) => prev + 1)
      setHasMore(response.data.length === itemsPerPage && offset + response.data.length < response.meta.total)
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

  return (
    <>
      <div className="gl-admin-media-library">
        <div className="gl-admin-media-header">
          <div className="gl-admin-media-header-left">
            <h1 className="gl-admin-media-header__title">Media Library</h1>

            {bulkSelectMode && selectedMedia.length > 0 && (
              <p className="gl-admin-media-header__count">{selectedMedia.length} selected</p>
            )}
            {/* <p className="gl-admin-media-header__count">{total} {total === 1 ? 'item' : 'items'}</p> */}
          </div>
          <div className="gl-admin-media-header-right">
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
            <div className="gl-admin-media-header__filters">
              <div className="gl-admin-media-header__filter-wrapper">
                <select
                  className="gl-admin-media-header__filter"
                  id="media-filter-author"
                  value={selectedUser}
                  onChange={handleUserChange}
                  disabled={loadingUsers}
                >
                  <option value="">All Users</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.full_name || user.username}
                    </option>
                  ))}
                </select>
              </div>
              <div className="gl-admin-media-header__filter-wrapper">
                <select
                  className="gl-admin-media-header__filter"
                  id="media-filter-type"
                  value={selectedType}
                  onChange={handleTypeChange}
                >
                  <option value="">All Types</option>
                  <option value="image">Images</option>
                  <option value="video">Videos</option>
                  <option value="audio">Audio</option>
                  <option value="document">Documents</option>
                </select>
              </div>
              <div className="gl-admin-media-header__sort-wrapper">
                <label htmlFor="media-sort" className="gl-admin-media-header__sort-label">
                  Sort by:
                </label>
                <select
                  className="gl-admin-media-header__sort"
                  id="media-sort"
                  value={sortBy}
                  onChange={handleSortChange}
                >
                  <option value="date_desc"> Newest First</option>
                  <option value="date_asc"> Oldest First</option>
                  <option value="name_asc"> Name A-Z</option>
                  <option value="name_desc"> Name Z-A</option>
                  <option value="size_asc"> Smallest First</option>
                  <option value="size_desc"> Largest First</option>
                  <option value="type_asc"> Type A-Z</option>
                  <option value="type_desc"> Type Z-A</option>
                  {/* TODO: add least used and most used */}
                </select>
              </div>
            </div>
            <div className="gl-admin-media-header__button-wrapper">
              <GLAdminButton
                className="gl-admin-media__bulk-select"
                variation={bulkSelectMode ? "primary" : "flat"}
                onClick={handleBulkSelectToggle}
              >
                <Icon name="bulkSelectIcon" color={bulkSelectMode ? "white" : "#333536"} width="14" height="14" />
                {bulkSelectMode ? "Exit Select" : "Bulk Select"}
              </GLAdminButton>
              <GLAdminButton className="gl-admin-media__new-media-btn" onClick={handleNewMediaClick}>
                <Icon name="add" color="white" width="14" height="14" /> New Media
              </GLAdminButton>
            </div>
          </div>
        </div>

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
                  <GLAdminButton className="gl-admin-media__upload-btn" onClick={handleUploadBtnClick}>
                    <Icon name="uploadIcon" color="white" width="14" height="14" /> Upload Files
                  </GLAdminButton>
                  <GLAdminButton
                    className="gl-admin-media__cancel-upload-btn"
                    variation="flat"
                    onClick={handleCancelUploadClick}
                  >
                    Cancel
                  </GLAdminButton>
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
      </div>
    </>
  )
}

export default Media