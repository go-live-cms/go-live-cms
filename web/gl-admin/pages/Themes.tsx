import React, { useEffect, useState } from "react"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import {
  getThemes,
  getActiveTheme,
  activateTheme,
  updateActiveThemeSettings,
  type Theme,
  type ActiveThemeWithSettings,
} from "@gl-admin/lib/api/themes"
import { authManager } from "@gl-admin/lib/auth"
import { toast } from "sonner"
import Button from "@gl-admin/components/ui/Button"
import Select from "@gl-admin/components/ui/Select"
import Modal from "@gl-admin/components/ui/Modal"
import "@gl-admin/assets/styles/pages/themes.scss"

const ThemesPage: React.FC = () => {
  const { baseTitle } = useGoLive()
  const [themes, setThemes] = useState<Theme[]>([])
  const [activeTheme, setActiveTheme] = useState<ActiveThemeWithSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [activating, setActivating] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [customizerOpen, setCustomizerOpen] = useState(false)

  // Layout variant state
  const [postLayout, setPostLayout] = useState("default")
  const [pageLayout, setPageLayout] = useState("default")

  useEffect(() => {
    document.title = `${baseTitle} Themes`
    fetchData()
  }, [baseTitle])

  const fetchData = async () => {
    try {
      setLoading(true)
      const token = authManager.getState().accessToken || undefined
      const [themesData, activeThemeData] = await Promise.all([getThemes(token), getActiveTheme(token)])

      setThemes(themesData)
      setActiveTheme(activeThemeData)

      // Set layout variants from settings
      if (activeThemeData.settings?.layout_variants) {
        setPostLayout(activeThemeData.settings.layout_variants.post || "default")
        setPageLayout(activeThemeData.settings.layout_variants.page || "default")
      }
    } catch (error) {
      console.error("Failed to fetch themes:", error)
      toast.error("Failed to load themes")
    } finally {
      setLoading(false)
    }
  }

  const handleActivateTheme = async (themeId: number) => {
    try {
      setActivating(themeId)
      const token = authManager.getState().accessToken || undefined
      await activateTheme(themeId, token)
      toast.success("Theme activated successfully!")
      await fetchData()
    } catch (error) {
      console.error("Failed to activate theme:", error)
      toast.error("Failed to activate theme")
    } finally {
      setActivating(null)
    }
  }

  const handleSaveLayoutSettings = async (e: React.FormEvent) => {
    e.preventDefault()

    try {
      setSaving(true)
      const token = authManager.getState().accessToken || undefined
      await updateActiveThemeSettings(
        {
          layout_variants: {
            post: postLayout,
            page: pageLayout,
          },
        },
        token
      )

      toast.success("Layout settings saved successfully!")
      await fetchData()
    } catch (error) {
      console.error("Failed to save layout settings:", error)
      toast.error("Failed to save layout settings")
    } finally {
      setSaving(false)
    }
  }

  const hasChanges =
    activeTheme &&
    (postLayout !== (activeTheme.settings?.layout_variants?.post || "default") ||
      pageLayout !== (activeTheme.settings?.layout_variants?.page || "default"))

  const getThemePreview = (theme: Theme) => {
    const title = theme.name || "Theme"
    const subtitle = theme.author ? `by ${theme.author}` : ""
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#0f172a" />
            <stop offset="50%" stop-color="#1e293b" />
            <stop offset="100%" stop-color="#2563eb" />
          </linearGradient>
        </defs>
        <rect width="800" height="450" fill="url(#bg)" />
        <rect x="40" y="40" width="720" height="370" rx="24" fill="#ffffff" fill-opacity="0.08" />
        <rect x="80" y="90" width="320" height="16" rx="8" fill="#ffffff" fill-opacity="0.45" />
        <rect x="80" y="120" width="220" height="12" rx="6" fill="#ffffff" fill-opacity="0.3" />
        <rect x="80" y="170" width="640" height="180" rx="18" fill="#0b1220" fill-opacity="0.45" />
        <text x="80" y="260" fill="#ffffff" font-size="40" font-family="Segoe UI, sans-serif" font-weight="600">${title}</text>
        <text x="80" y="300" fill="#cbd5f5" font-size="18" font-family="Segoe UI, sans-serif">${subtitle}</text>
      </svg>
    `

    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  }

  const getThemeThumbnail = (theme: Theme) => `/themes/${theme.slug}/thumbnail.jpg`

  const handleThemeImageError = (event: React.SyntheticEvent<HTMLImageElement>, theme: Theme) => {
    event.currentTarget.src = getThemePreview(theme)
  }

  if (loading) {
    return (
      <div className="admin-header">
        <h1>🎨 Themes</h1>
        <p>Loading themes...</p>
      </div>
    )
  }

  return (
    <div className="themes-page">
      <div className="admin-header">
        <h1>🎨 Themes</h1>
        <p>Manage your site's appearance</p>
      </div>

      {/* Active Theme Section */}
      <section className="themes-active">
        <div className="themes-active__header">
          <h2>Active Theme</h2>
          {activeTheme && <Button onClick={() => setCustomizerOpen(true)}>Customize</Button>}
        </div>
        {activeTheme && (
          <div className="themes-active__card">
            <div className="theme-preview theme-preview--large">
              <img
                src={getThemeThumbnail(activeTheme)}
                alt={`${activeTheme.name} preview`}
                onError={(event) => handleThemeImageError(event, activeTheme)}
              />
              <span className="theme-badge">Active</span>
            </div>
            <div className="themes-active__content">
              <h3>{activeTheme.name}</h3>
              <p className="themes-active__meta">
                Version {activeTheme.version} by {activeTheme.author}
              </p>
              <p className="themes-active__description">{activeTheme.description}</p>
              <div className="themes-active__actions">
                <Button onClick={() => setCustomizerOpen(true)}>Open Customizer</Button>
                <Button
                  variation="secondary"
                  onClick={() => {
                    setPostLayout(activeTheme.settings?.layout_variants?.post || "default")
                    setPageLayout(activeTheme.settings?.layout_variants?.page || "default")
                  }}
                >
                  Reset Layouts
                </Button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Available Themes Section */}
      <section className="themes-selector">
        <div className="themes-selector__header">
          <h2>Available Themes ({themes.length})</h2>
          <p>Browse and activate themes just like WordPress.</p>
        </div>
        <div className="theme-grid">
          {themes.map((theme) => (
            <div key={theme.id} className={`theme-card${theme.active ? "theme-card--active" : ""}`}>
              <div className="theme-card__preview">
                <img
                  src={getThemeThumbnail(theme)}
                  alt={`${theme.name} preview`}
                  onError={(event) => handleThemeImageError(event, theme)}
                />
                {theme.active && <span className="theme-badge">Active</span>}
              </div>
              <div className="theme-card__body">
                <h3 className="theme-card__title">{theme.name}</h3>
                <p className="theme-card__meta">
                  Version {theme.version} by {theme.author}
                </p>
                <p className="theme-card__description">{theme.description}</p>
                <p className="theme-card__layouts">
                  Layouts: {theme.config.layouts.post.variants.length} post variants,{" "}
                  {theme.config.layouts.page.variants.length} page variants
                </p>
              </div>
              <div className="theme-card__actions">
                {theme.active ? (
                  <Button onClick={() => setCustomizerOpen(true)}>Customize</Button>
                ) : (
                  <Button onClick={() => handleActivateTheme(theme.id)} disabled={activating === theme.id}>
                    {activating === theme.id ? "Activating..." : "Activate"}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {activeTheme && (
        <Modal isOpen={customizerOpen} onClose={() => setCustomizerOpen(false)} title="Theme Customizer" size="large">
          <div className="themes-customizer">
            <div className="themes-customizer__summary">
              <div className="theme-preview theme-preview--small">
                <img
                  src={getThemeThumbnail(activeTheme)}
                  alt={`${activeTheme.name} preview`}
                  onError={(event) => handleThemeImageError(event, activeTheme)}
                />
              </div>
              <div>
                <h3>{activeTheme.name}</h3>
                <p className="themes-customizer__meta">
                  Version {activeTheme.version} by {activeTheme.author}
                </p>
              </div>
            </div>

            <form onSubmit={handleSaveLayoutSettings} className="admin-form themes-customizer__form">
              <h4>Layout Settings</h4>
              <div className="form-group">
                <Select
                  label="Default Post Layout"
                  value={postLayout}
                  onChange={setPostLayout}
                  options={activeTheme.config.layouts.post.variants.map((variant) => ({
                    value: variant,
                    label: variant.charAt(0).toUpperCase() + variant.slice(1),
                  }))}
                />
              </div>

              <div className="form-group">
                <Select
                  label="Default Page Layout"
                  value={pageLayout}
                  onChange={setPageLayout}
                  options={activeTheme.config.layouts.page.variants.map((variant) => ({
                    value: variant,
                    label: variant.charAt(0).toUpperCase() + variant.slice(1),
                  }))}
                />
              </div>

              <div className="themes-customizer__actions">
                <Button type="submit" disabled={!hasChanges || saving}>
                  {saving ? "Saving..." : "Save Layout Settings"}
                </Button>
                {hasChanges && (
                  <Button
                    type="button"
                    variation="secondary"
                    onClick={() => {
                      setPostLayout(activeTheme.settings?.layout_variants?.post || "default")
                      setPageLayout(activeTheme.settings?.layout_variants?.page || "default")
                    }}
                  >
                    Reset
                  </Button>
                )}
                <Button type="button" variation="secondary" onClick={() => setCustomizerOpen(false)}>
                  Close
                </Button>
              </div>
            </form>
          </div>
        </Modal>
      )}
    </div>
  )
}

export default ThemesPage
