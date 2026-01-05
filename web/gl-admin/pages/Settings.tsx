import React, { useEffect, useState } from "react"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import { getSettings, updateSettings, type Settings } from "@gl-admin/lib/api/settings"
import { authManager } from "@gl-admin/lib/auth"
import { toast } from "sonner"
import Button from "@gl-admin/components/ui/Button"

const SettingsPage: React.FC = () => {
  const { baseTitle } = useGoLive()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Form state
  const [postURLStructure, setPostURLStructure] = useState<"id" | "slug">("id")
  const [siteTitle, setSiteTitle] = useState("")
  const [postsPerPage, setPostsPerPage] = useState(10)

  useEffect(() => {
    document.title = `${baseTitle} Settings`
    fetchSettings()
  }, [baseTitle])

  const fetchSettings = async () => {
    try {
      setLoading(true)
      const token = authManager.getState().accessToken || undefined
      const data = await getSettings(token)
      setSettings(data)
      setPostURLStructure(data.post_url_structure)
      setSiteTitle(data.site_title)
      setPostsPerPage(data.posts_per_page)
    } catch (error) {
      console.error("Failed to fetch settings:", error)
      toast.error("Failed to load settings")
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()

    try {
      setSaving(true)
      const token = authManager.getState().accessToken || undefined
      const updatedSettings = await updateSettings(
        {
          post_url_structure: postURLStructure,
          site_title: siteTitle,
          posts_per_page: postsPerPage,
        },
        token
      )

      setSettings(updatedSettings)
      toast.success("Settings saved successfully!")

      // Note: In dev mode, changes take effect immediately
      // In production, you'll need to trigger a rebuild
      if (postURLStructure !== settings?.post_url_structure) {
        toast.info("URL structure changed. Restart dev server to see changes.", { duration: 5000 })
      }
    } catch (error) {
      console.error("Failed to save settings:", error)
      toast.error("Failed to save settings")
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    if (settings) {
      setPostURLStructure(settings.post_url_structure)
      setSiteTitle(settings.site_title)
      setPostsPerPage(settings.posts_per_page)
      toast.info("Changes reverted")
    }
  }

  if (loading) {
    return (
      <div className="admin-header">
        <h1>⚙️ Settings</h1>
        <p>Loading settings...</p>
      </div>
    )
  }

  const hasChanges =
    settings &&
    (postURLStructure !== settings.post_url_structure ||
      siteTitle !== settings.site_title ||
      postsPerPage !== settings.posts_per_page)

  return (
    <>
      <div className="admin-header">
        <h1>⚙️ Settings</h1>
        <p>Configure your Go Live CMS</p>
      </div>

      <div className="settings-container" style={{ maxWidth: "800px", margin: "0 auto" }}>
        <form onSubmit={handleSave}>
          {/* Post URL Structure */}
          <div className="settings-section">
            <h2>📄 Post URLs</h2>
            <p className="settings-description">
              Choose how your post URLs are structured. This affects how visitors access your content.
            </p>

            <div className="form-group">
              <label htmlFor="post_url_structure">URL Structure</label>
              <select
                id="post_url_structure"
                value={postURLStructure}
                onChange={(e) => setPostURLStructure(e.target.value as "id" | "slug")}
                className="form-select"
              >
                <option value="id">Numeric ID (e.g., /post/123)</option>
                <option value="slug">Slug (e.g., /post/my-awesome-post)</option>
              </select>
              <small className="form-help">
                {postURLStructure === "id"
                  ? "URLs will use numeric IDs. Simple and never conflicts."
                  : "URLs will use post titles (slugs). More SEO-friendly but requires unique titles."}
              </small>
            </div>

            {postURLStructure === "slug" && (
              <div
                className="settings-notice"
                style={{ marginTop: "1rem", padding: "1rem", backgroundColor: "#fef3c7", borderRadius: "0.5rem" }}
              >
                <strong>⚠️ Note:</strong> Changing URL structure in dev mode requires a server restart. In production,
                this will trigger a site rebuild.
              </div>
            )}
          </div>

          {/* Site Title */}
          <div className="settings-section" style={{ marginTop: "2rem" }}>
            <h2>🏷️ Site Information</h2>

            <div className="form-group">
              <label htmlFor="site_title">Site Title</label>
              <input
                type="text"
                id="site_title"
                value={siteTitle}
                onChange={(e) => setSiteTitle(e.target.value)}
                className="form-input"
                placeholder="Go Live CMS"
                maxLength={200}
              />
              <small className="form-help">Appears in browser tabs and search results</small>
            </div>
          </div>

          {/* Posts Per Page */}
          <div className="settings-section" style={{ marginTop: "2rem" }}>
            <h2>📊 Display Options</h2>

            <div className="form-group">
              <label htmlFor="posts_per_page">Posts Per Page</label>
              <input
                type="number"
                id="posts_per_page"
                value={postsPerPage}
                onChange={(e) => setPostsPerPage(parseInt(e.target.value, 10))}
                className="form-input"
                min={1}
                max={100}
              />
              <small className="form-help">Number of posts to show on archive pages</small>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="settings-actions" style={{ marginTop: "2rem", display: "flex", gap: "1rem" }}>
            <Button type="submit" variation="primary" disabled={!hasChanges || saving}>
              {saving ? "Saving..." : "Save Settings"}
            </Button>
            <Button type="button" variation="secondary" onClick={handleReset} disabled={!hasChanges || saving}>
              Reset
            </Button>
          </div>

          {settings && (
            <div className="settings-meta" style={{ marginTop: "2rem", fontSize: "0.875rem", color: "#6b7280" }}>
              <p>Last updated: {new Date(settings.changed_at).toLocaleString()}</p>
            </div>
          )}
        </form>
      </div>

      <style>{`
        .settings-container {
          padding: 2rem;
        }

        .settings-section {
          border-bottom: 1px solid #e5e7eb;
          padding-bottom: 2rem;
        }

        .settings-section:last-of-type {
          border-bottom: none;
        }

        .settings-section h2 {
          font-size: 1.25rem;
          font-weight: 600;
          margin-bottom: 0.5rem;
        }

        .settings-description {
          color: #6b7280;
          margin-bottom: 1.5rem;
        }

        .form-group {
          margin-bottom: 1.5rem;
        }

        .form-group label {
          display: block;
          font-weight: 500;
          margin-bottom: 0.5rem;
        }

        .form-select,
        .form-input {
          width: 100%;
          padding: 0.5rem;
          border: 1px solid #d1d5db;
          border-radius: 0.375rem;
          font-size: 1rem;
        }

        .form-select:focus,
        .form-input:focus {
          outline: none;
          border-color: #3b82f6;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }

        .form-help {
          display: block;
          margin-top: 0.25rem;
          font-size: 0.875rem;
          color: #6b7280;
        }

        .settings-notice {
          font-size: 0.875rem;
        }

        .settings-actions {
          padding-top: 2rem;
          border-top: 1px solid #e5e7eb;
        }
      `}</style>
    </>
  )
}

export default SettingsPage
