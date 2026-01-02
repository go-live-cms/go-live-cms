import React, { useState, useEffect } from "react"
import FeaturedImage from "./FeaturedImage"
import { useFeaturedImage } from "@gl-admin/lib/hooks/useFeaturedImage"
import type { Post, PostType } from "@gl-admin/lib/api/types"
import { getSettings, type Settings } from "@gl-admin/lib/api/settings"
import "@gl-admin/assets/styles/components/editor/post-sidebar.scss"

interface PostSidebarProps {
  post: Post
  postType: PostType
  onUpdate: (updates: Partial<Post>) => void
  isVisible: boolean
  onToggle: () => void
  sidebarWidth: string
  onResize: (e: React.MouseEvent) => void
  slug?: string
  mode?: "create" | "edit"
  onSlugChange?: (slug: string) => void
}

export default function PostSidebar({
  post,
  postType,
  onUpdate,
  isVisible,
  onToggle,
  sidebarWidth,
  onResize,
  slug,
  mode = "create",
  onSlugChange,
}: PostSidebarProps) {
  const [activeTab, setActiveTab] = useState<"general" | "advanced">("general")
  const [urlStructure, setUrlStructure] = useState<"id" | "slug">("id")

  const {
    featuredImage,
    loading: featuredImageLoading,
    error: featuredImageError,
    setImage: setFeaturedImage,
  } = useFeaturedImage(post.id)

  // Fetch settings to determine URL structure
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const settings = await getSettings()
        setUrlStructure(settings.post_url_structure)
      } catch (error) {
        console.error("Failed to fetch settings:", error)
        // Default to 'id' if settings can't be fetched
        setUrlStructure("id")
      }
    }
    fetchSettings()
  }, [])

  const handleFieldUpdate = (field: keyof Post, value: any) => {
    onUpdate({ [field]: value })
  }

  const handleSlugUpdate = (newSlug: string) => {
    if (onSlugChange) {
      onSlugChange(newSlug)
    }

    handleFieldUpdate("url", newSlug)
  }

  const getContentTypeName = () => {
    return postType.name?.toLowerCase() || "post"
  }

  const getFrontendUrl = (identifier: string | number) => {
    const baseUrl = window.location.origin
    const contentType = getContentTypeName()
    return `${baseUrl}/${contentType}/${identifier}`
  }

  const getCurrentLiveUrl = () => {
    if (mode === "edit" && post.id) {
      // Use the configured URL structure
      if (urlStructure === "slug" && post.url) {
        return getFrontendUrl(post.url)
      }
      return getFrontendUrl(post.id)
    }
    return null
  }

  const getFutureUrl = () => {
    const urlSlug = slug || post.url || "untitled"
    if (urlStructure === "slug") {
      return getFrontendUrl(urlSlug)
    }
    // If structure is ID-based, show what it will be (still uses ID)
    return getFrontendUrl(post.id || "new")
  }

  const statusOptions = [
    { value: "draft", label: "Draft", description: "Not visible to the public" },
    { value: "published", label: "Published", description: "Visible to everyone" },
    { value: "archived", label: "Archived", description: "Hidden from listings" },
  ]

  return (
    <div className={`post-settings ${isVisible ? "post-settings--visible" : ""}`} style={{ width: sidebarWidth }}>
      <div className="post-settings__resize-handle" onMouseDown={onResize}></div>
      <div className="post-settings__header">
        <h3>Post Settings</h3>
        <button className="post-settings__close" onClick={onToggle} aria-label="Close settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
      </div>

      <div className="post-settings__tabs">
        <button
          className={`post-settings__tab ${activeTab === "general" ? "active" : ""}`}
          onClick={() => setActiveTab("general")}
        >
          General
        </button>
        <button
          className={`post-settings__tab ${activeTab === "advanced" ? "active" : ""}`}
          onClick={() => setActiveTab("advanced")}
        >
          Advanced
        </button>
      </div>

      <div className="post-settings__content">
        {activeTab === "general" && (
          <>
            <div className="post-settings__section">
              <h4>Status & Visibility</h4>
              <div className="post-settings__field">
                <label htmlFor="post-status">Status</label>
                <select
                  id="post-status"
                  value={post.post_status || "draft"}
                  onChange={(e) => handleFieldUpdate("post_status", e.target.value)}
                >
                  {statusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <small className="post-settings__field-description">
                  {statusOptions.find((opt) => opt.value === (post.post_status || "draft"))?.description}
                </small>
              </div>
            </div>

            <div className="post-settings__section">
              <h4>Post URL</h4>
              <div className="post-settings__field">
                <label htmlFor="post-slug">Slug *</label>
                <input
                  type="text"
                  id="post-slug"
                  name="slug"
                  value={slug || post.url || ""}
                  onChange={(e) => handleSlugUpdate(e.target.value)}
                  placeholder="url-slug"
                  required
                />
                <small className="post-settings__field-description">The URL slug for this post</small>
              </div>

              {mode === "edit" && post.id && post.post_status === "published" && (
                <div className="post-settings__field">
                  <label>Current Live URL</label>
                  <div className="post-settings__url-preview">
                    <a
                      href={getCurrentLiveUrl()!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="post-settings__url-link"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ marginRight: "6px" }}>
                        <path
                          d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
                          stroke="currentColor"
                          strokeWidth="2"
                        />
                        <polyline points="15,3 21,3 21,9" stroke="currentColor" strokeWidth="2" />
                        <line x1="10" y1="14" x2="21" y2="3" stroke="currentColor" strokeWidth="2" />
                      </svg>
                      {getCurrentLiveUrl()}
                    </a>
                  </div>
                  <small className="post-settings__field-description">
                    Current live URL (uses {urlStructure === "id" ? `ID: ${post.id}` : `slug: ${post.url}`})
                  </small>
                </div>
              )}

              <div className="post-settings__field">
                <label>{mode === "create" ? "Future URL" : "URL Preview"}</label>
                <div className="post-settings__url-preview">
                  <span className="post-settings__url-preview-text">{getFutureUrl()}</span>
                </div>
                <small className="post-settings__field-description">
                  {mode === "create"
                    ? `This will be the URL after publishing (using ${urlStructure === "id" ? "ID" : "slug"})`
                    : urlStructure === "slug"
                      ? "This will become the new URL after saving"
                      : "URL will continue using ID-based structure"}
                </small>
              </div>

              <div className="post-settings__field">
                <small className="post-settings__field-description" style={{ fontStyle: "italic", marginTop: "8px" }}>
                  <strong>Active URL Structure:</strong> {urlStructure === "id" ? "ID-based" : "Slug-based"}
                  <br />
                  {urlStructure === "id" ? (
                    <>
                      • Current format:{" "}
                      <code>
                        /{getContentTypeName()}/{post.id || "123"}
                      </code>
                      <br />• Change to slug-based in{" "}
                      <a href="/settings" target="_blank" style={{ color: "inherit", textDecoration: "underline" }}>
                        Settings
                      </a>
                    </>
                  ) : (
                    <>
                      • Current format:{" "}
                      <code>
                        /{getContentTypeName()}/{slug || post.url || "your-slug"}
                      </code>
                      <br />• ID-based URLs (/{getContentTypeName()}/{post.id}) still work for compatibility
                    </>
                  )}
                </small>
              </div>

              <div className="post-settings__field">
                <label htmlFor="post-description">Description</label>
                <textarea
                  id="post-description"
                  value={post.description || ""}
                  onChange={(e) => handleFieldUpdate("description", e.target.value)}
                  rows={3}
                  placeholder="Brief description of this post..."
                />
                <small className="post-settings__field-description">
                  A short summary shown in listings and previews
                </small>
              </div>
            </div>

            <div className="post-settings__section">
              <FeaturedImage value={featuredImage} onChange={setFeaturedImage} postId={post.id} disabled={!post.id} />
              {featuredImageError && <small className="post-settings__field-error">Error: {featuredImageError}</small>}
            </div>
          </>
        )}

        {activeTab === "advanced" && (
          <>
            <div className="post-settings__section">
              <h4>Timestamps</h4>
              <div className="post-settings__field">
                <label htmlFor="created-at">Created</label>
                <input
                  type="datetime-local"
                  id="created-at"
                  value={post.created_at ? new Date(post.created_at).toISOString().slice(0, 16) : ""}
                  onChange={(e) =>
                    handleFieldUpdate("created_at", e.target.value ? new Date(e.target.value).toISOString() : null)
                  }
                />
              </div>

              <div className="post-settings__field">
                <label htmlFor="updated-at">Last Modified</label>
                <input
                  type="datetime-local"
                  id="updated-at"
                  value={post.changed_at ? new Date(post.changed_at).toISOString().slice(0, 16) : ""}
                  disabled
                />
                <small className="post-settings__field-description">Automatically updated when post is saved</small>
              </div>
            </div>

            <div className="post-settings__section">
              <h4>Meta Data</h4>
              <div className="post-settings__field">
                <label htmlFor="post-author">User ID</label>
                <input
                  type="number"
                  id="post-author"
                  value={post.user_id || ""}
                  onChange={(e) => handleFieldUpdate("user_id", parseInt(e.target.value) || null)}
                />
                <small className="post-settings__field-description">The ID of the user who created this post</small>
              </div>

              <div className="post-settings__field">
                <label>Post ID</label>
                <input type="text" value={post.id || "Not assigned yet"} disabled />
                <small className="post-settings__field-description">
                  {mode === "create" ? "Will be assigned when post is saved" : "Unique identifier for this post"}
                </small>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
