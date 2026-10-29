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
import { toast } from "@gl-admin/components/ui/Toast"
import Button from "@gl-admin/components/ui/Button"
import Pill from "@gl-admin/components/ui/Pill"
import Select from "@gl-admin/components/ui/Select"
import Modal from "@gl-admin/components/ui/Modal"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import { ExternalIcon } from "@gl-admin/components/ui/icons"
import { errorMessage } from "@gl-admin/lib/api/errors"
import "@gl-admin/assets/styles/pages/workspace.scss"
import "@gl-admin/assets/styles/pages/themes.scss"

// Themes (restyled in #343, the Themes board): the active theme with its layout
// customizer, and the other installed themes to activate.
//
// Hidden until #332: uploading a theme and theme updates ("Update to x.y"), with the
// per-theme menu that would hold them. A theme's own settings beyond the post and page
// layouts don't exist yet, so Customize only picks those.

const variantLabel = (variant: string) => variant.charAt(0).toUpperCase() + variant.slice(1)

const ThemesPage: React.FC = () => {
  const { baseTitle } = useGoLive()
  const [themes, setThemes] = useState<Theme[]>([])
  const [activeTheme, setActiveTheme] = useState<ActiveThemeWithSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)
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
      setLoadError(null)
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
      setLoadError(error)
    } finally {
      setLoading(false)
    }
  }

  const handleActivateTheme = async (theme: Theme) => {
    try {
      setActivating(theme.id)
      const token = authManager.getState().accessToken || undefined
      await activateTheme(theme.id, token)
      toast.success(`${theme.name} is now your theme`)
      await fetchData()
    } catch (error) {
      console.error("Failed to activate theme:", error)
      toast.error(`Couldn't activate ${theme.name}. ${errorMessage(error)}`)
    } finally {
      setActivating(null)
    }
  }

  const resetLayouts = () => {
    setPostLayout(activeTheme?.settings?.layout_variants?.post || "default")
    setPageLayout(activeTheme?.settings?.layout_variants?.page || "default")
  }

  const closeCustomizer = () => {
    resetLayouts()
    setCustomizerOpen(false)
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

      toast.success("Layouts saved")
      setCustomizerOpen(false)
      await fetchData()
    } catch (error) {
      console.error("Failed to save layout settings:", error)
      toast.error(`Couldn't save the layouts. ${errorMessage(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const hasChanges =
    activeTheme &&
    (postLayout !== (activeTheme.settings?.layout_variants?.post || "default") ||
      pageLayout !== (activeTheme.settings?.layout_variants?.page || "default"))

  const header = (
    <header className="gl-workspace__header">
      <div className="gl-workspace__heading">
        <h1>Themes</h1>
        <span className="gl-workspace__subtitle">How your site looks to readers. Switching themes doesn't change your content.</span>
      </div>
    </header>
  )

  if (loading) {
    return (
      <div className="gl-workspace gl-themes" aria-busy="true">
        {header}
        <Skeleton height={280} />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="gl-workspace gl-themes">
        {header}
        <EmptyState
          variant="error"
          icon="close"
          title="Couldn't load themes"
          description={errorMessage(loadError)}
          action={
            <Button variant="primary" onClick={fetchData}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  const others = themes.filter((t) => t.id !== activeTheme?.id)

  return (
    <div className="gl-workspace gl-themes">
      {header}

      {activeTheme && (
        <section className="gl-theme-active" aria-labelledby="gl-theme-active-name">
          <ThemePreview theme={activeTheme} className="gl-theme-active__preview" />
          <div className="gl-theme-active__body">
            <div className="gl-theme-active__title">
              <h2 id="gl-theme-active-name">{activeTheme.name}</h2>
              <Pill tone="success">Active</Pill>
            </div>
            {activeTheme.description && <p className="gl-workspace__muted">{activeTheme.description}</p>}
            <dl className="gl-theme-facts">
              <dt>Version</dt>
              <dd>{activeTheme.version}</dd>
              {activeTheme.author && (
                <>
                  <dt>Made by</dt>
                  <dd>{activeTheme.author}</dd>
                </>
              )}
              <dt>Layouts</dt>
              <dd>
                {plural(activeTheme.config.layouts.post.variants.length, "post layout", "post layouts")},{" "}
                {plural(activeTheme.config.layouts.page.variants.length, "page layout", "page layouts")}
              </dd>
            </dl>
            <div className="gl-theme-active__actions">
              <Button variant="primary" size="lg" onClick={() => setCustomizerOpen(true)}>
                Customize
              </Button>
              <a className="gl-button gl-button--secondary gl-button--lg" href="/" target="_blank" rel="noreferrer">
                <span className="gl-button__label">View site</span>
                <span className="gl-button__icon" aria-hidden="true">
                  <ExternalIcon size={14} />
                </span>
                <span className="gl-workspace__sr"> (opens in a new tab)</span>
              </a>
            </div>
          </div>
        </section>
      )}

      <section className="gl-workspace__section" aria-labelledby="gl-themes-installed">
        <h2 className="gl-workspace__section-title" id="gl-themes-installed">
          Installed
        </h2>
        {others.length === 0 ? (
          <EmptyState compact icon="content" title="No other themes installed" description="Themes in web/themes show up here." />
        ) : (
          <div className="gl-theme-grid">
            {others.map((theme) => (
              <article key={theme.id} className="gl-theme-card" aria-labelledby={`gl-theme-${theme.id}`}>
                <ThemePreview theme={theme} className="gl-theme-card__preview" />
                <div className="gl-theme-card__body">
                  <div className="gl-theme-card__title">
                    <h3 id={`gl-theme-${theme.id}`}>{theme.name}</h3>
                    <span className="gl-workspace__muted">{theme.version}</span>
                  </div>
                  {theme.description && <p className="gl-workspace__muted">{theme.description}</p>}
                  {theme.author && <p className="gl-theme-card__author">By {theme.author}</p>}
                  <Button
                    variant="secondary"
                    className="gl-theme-card__activate"
                    loading={activating === theme.id}
                    disabled={activating !== null && activating !== theme.id}
                    aria-label={`Activate ${theme.name}`}
                    onClick={() => handleActivateTheme(theme)}
                  >
                    Activate
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {activeTheme && (
        <Modal
          isOpen={customizerOpen}
          onClose={closeCustomizer}
          title={`Customize ${activeTheme.name}`}
          description="The layout new posts and pages use unless they pick their own."
          size="medium"
          footer={
            <div className="gl-themes__footer">
              <Button variant="secondary" onClick={closeCustomizer} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" form="gl-theme-layouts" loading={saving} disabled={!hasChanges}>
                Save layouts
              </Button>
            </div>
          }
        >
          <form id="gl-theme-layouts" className="gl-workspace__form" onSubmit={handleSaveLayoutSettings}>
            <Select
              label="Post layout"
              value={postLayout}
              onChange={setPostLayout}
              options={activeTheme.config.layouts.post.variants.map((variant) => ({ value: variant, label: variantLabel(variant) }))}
            />
            <Select
              label="Page layout"
              value={pageLayout}
              onChange={setPageLayout}
              options={activeTheme.config.layouts.page.variants.map((variant) => ({ value: variant, label: variantLabel(variant) }))}
            />
          </form>
        </Modal>
      )}
    </div>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// The theme's thumbnail.jpg, or a drawn stand-in when it has none.
function ThemePreview({ theme, className }: { theme: Theme; className: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [theme.slug])
  return (
    <div className={`gl-theme-preview ${className}`}>
      {failed ? (
        <div className="gl-theme-preview__stand-in" role="img" aria-label={`${theme.name}: no preview image`}>
          <span className="gl-theme-preview__line is-title" />
          <span className="gl-theme-preview__line" />
          <span className="gl-theme-preview__line is-short" />
          <span className="gl-theme-preview__block" />
        </div>
      ) : (
        <img src={`/themes/${theme.slug}/thumbnail.jpg`} alt={`Preview of the ${theme.name} theme`} onError={() => setFailed(true)} />
      )}
    </div>
  )
}

export default ThemesPage
