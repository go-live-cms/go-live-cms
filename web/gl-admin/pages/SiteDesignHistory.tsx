import { useCallback, useEffect, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import Button, { IconButton, buttonClassName } from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import { toast } from "@gl-admin/components/ui/Toast"
import { ChevronDownIcon, ChevronRightIcon, WarningIcon } from "@gl-admin/components/ui/icons"
import { ErrorPage } from "@gl-admin/components/errors/ErrorPages"
import { ConfirmDialog } from "@gl-admin/components/site-editor/SiteDesignDialogs"
import { loadSiteDesignContext, type SiteDesignContext } from "@gl-admin/components/site-editor/siteContext"
import { MOBILE_QUERY } from "@gl-admin/components/sidebar/Sidebar"
import { useMediaQuery } from "@gl-admin/lib/hooks/useMediaQuery"
import { usePageTitle } from "@gl-admin/lib/hooks/usePageTitle"
import {
  getGlobalStyles,
  listSiteDesignReleases,
  restoreGlobalStyleVersion,
  type SiteDesignRelease,
  type SiteTemplatePublished,
} from "@gl-admin/lib/api/siteDesign"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { groupsLabel, releaseSummary, releaseTime, siteTemplateName } from "@gl-admin/lib/siteDesign"
import { plural } from "@gl-admin/utils/formatting"
import "@gl-admin/assets/styles/pages/site-editor.scss"

// The Site editor's History (#493; the board "Site editor · history", design 5.3, 13 item 8):
// each publish of the site design is a release, newest first; open one to see what changed
// together and restore an item. A template or part restores through its editor (rule 9: the
// editor opens and asks); the global styles restore into the draft by REST. Nothing reaches
// readers until the next publish. At phone width it reads only (13.1).

const PAGE = 20

type StylesSummary = { groups?: string[]; contrast_failures?: number }

function stylesOf(release: SiteDesignRelease): StylesSummary | null {
  const styles = release.summary?.global_styles
  return styles && typeof styles === "object" ? (styles as StylesSummary) : null
}

export default function SiteDesignHistoryPage() {
  usePageTitle("Site editor history")
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const itemId = Number(search.get("item")) || null
  const phone = useMediaQuery(MOBILE_QUERY)
  const [context, setContext] = useState<SiteDesignContext | null>(null)
  const [releases, setReleases] = useState<SiteDesignRelease[] | null>(null)
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [loadingMore, setLoadingMore] = useState(false)
  const [restoreStyles, setRestoreStyles] = useState<{ release: SiteDesignRelease; version: number } | null>(null)
  const [restored, setRestored] = useState<{ when: string; groups: string } | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const [ctx, page] = await Promise.all([loadSiteDesignContext(), listSiteDesignReleases({ limit: PAGE })])
      setContext(ctx)
      setReleases(page.releases)
      setNextBefore(page.next_before)
      // The newest one starts open, as on the board.
      if (page.releases[0]) setOpen(new Set([page.releases[0].id]))
    } catch (error) {
      setLoadError(error)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const more = async () => {
    if (!nextBefore) return
    setLoadingMore(true)
    try {
      const page = await listSiteDesignReleases({ limit: PAGE, before: nextBefore })
      setReleases((current) => [...(current ?? []), ...page.releases])
      setNextBefore(page.next_before)
    } catch (error) {
      toast.error(`Couldn’t load older releases. ${errorMessage(error)}`)
    } finally {
      setLoadingMore(false)
    }
  }

  if (loadError) return <ErrorPage error={loadError} onRetry={() => void load()} />
  if (!context || !releases) return <LoadingHistory />

  const name = (item: SiteTemplatePublished) => siteTemplateName(item.kind, item.slug, context.vocabulary, item.title)
  const shown = itemId ? releases.filter((release) => release.items.some((item) => item.id === itemId)) : releases
  const itemName = itemId ? (releases.flatMap((r) => r.items).find((item) => item.id === itemId) ?? null) : null
  const toggle = (id: number) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="site-editor">
      <header className="site-editor__head">
        <div className="site-editor__title">
          <nav aria-label="Breadcrumb" className="site-editor__crumb">
            <Link to="/site-editor">Site editor</Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page">History</span>
          </nav>
          <h1>{itemName ? `History · ${name(itemName)}` : "History"}</h1>
          <p className="site-editor__sub">
            {context.themeName} · {plural(shown.length, "release", "releases")}
            {nextBefore && !itemId ? " so far" : ""}
          </p>
        </div>
        {itemId && (
          <Link to="/site-editor/history" className={buttonClassName("secondary", "md")}>
            Show every release
          </Link>
        )}
      </header>

      {restored && (
        <Notice
          tone="info"
          live="status"
          title={`Global styles from ${restored.when} restored to the draft`}
          onDismiss={() => setRestored(null)}
          actions={
            <Link to="/site-editor/styles" className={buttonClassName("secondary", "sm")}>
              Open global styles
            </Link>
          }
        >
          {restored.groups} changed. They go live when you publish the site design.
        </Notice>
      )}
      {phone && <Notice tone="info">Restoring needs a larger screen.</Notice>}

      {shown.length === 0 ? (
        <div className="site-editor__empty">
          <strong>No releases yet</strong>
          <span>Each time you publish the site design, what changed is listed here with a version you can restore.</span>
        </div>
      ) : (
        <ol className="site-editor-releases">
          {shown.map((release, index) => {
            const styles = stylesOf(release)
            const expanded = open.has(release.id)
            const live = index === 0 && !itemId
            return (
              <li key={release.id} className={`site-editor-release${expanded ? " is-open" : ""}`}>
                <div className="site-editor-release__head">
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-expanded={expanded}
                    aria-controls={`release-${release.id}`}
                    aria-label={expanded ? `Hide what changed on ${releaseTime(release.published_at)}` : `Show what changed on ${releaseTime(release.published_at)}`}
                    icon={expanded ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
                    onClick={() => toggle(release.id)}
                  />
                  <span className="site-editor-release__text">
                    <span className="site-editor-release__time">
                      <strong>{releaseTime(release.published_at)}</strong>
                      {live && <span className="site-editor__tag is-live">Live</span>}
                    </span>
                    <span className="site-editor__sub">
                      {release.published_by_name || "Someone"} · {releaseSummary(release.items, styles?.groups ?? null, context.vocabulary)}
                    </span>
                  </span>
                  {!!styles?.contrast_failures && (
                    <span className="site-editor__flag">
                      <WarningIcon size={14} />
                      Published with {plural(styles.contrast_failures, "contrast warning", "contrast warnings")}
                    </span>
                  )}
                </div>
                {expanded && (
                  <ul id={`release-${release.id}`} className="site-editor-release__items">
                    {release.items.map((item) => (
                      <li key={`${item.id}:${item.version_no}`} className="site-editor-release__item">
                        <span className="site-editor-release__text">
                          <span>{name(item)}</span>
                          <span className="site-editor__sub">
                            {item.kind === "part" ? "Template part" : "Template"} ·{" "}
                            {item.reset ? `reset to ${context.themeName}’s default` : `version ${item.version_no}`}
                          </span>
                        </span>
                        {!phone && (
                          <>
                            <Link to={`/site-editor/templates/${item.id}`} className={buttonClassName("ghost", "md")} aria-label={`Open ${name(item)}`}>
                              Open
                            </Link>
                            {!item.reset && (
                              <Button
                                variant="secondary"
                                aria-label={`Restore ${name(item)} from ${releaseTime(release.published_at)}`}
                                onClick={() => navigate(`/site-editor/templates/${item.id}?restore=${item.version_no}`)}
                              >
                                Restore…
                              </Button>
                            )}
                          </>
                        )}
                      </li>
                    ))}
                    {release.global_styles_version != null && (
                      <li className="site-editor-release__item">
                        <span className="site-editor-release__text">
                          <span>Global styles</span>
                          <span className="site-editor__sub">
                            {groupsLabel(styles?.groups)} · version {release.global_styles_version}
                          </span>
                        </span>
                        {!phone && (
                          <Button
                            variant="secondary"
                            aria-label={`Restore the global styles from ${releaseTime(release.published_at)}`}
                            onClick={() => setRestoreStyles({ release, version: release.global_styles_version! })}
                          >
                            Restore…
                          </Button>
                        )}
                      </li>
                    )}
                  </ul>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {nextBefore && !itemId && (
        <Button variant="secondary" onClick={() => void more()} loading={loadingMore}>
          Show older releases
        </Button>
      )}

      <ConfirmDialog
        isOpen={restoreStyles !== null}
        onClose={() => setRestoreStyles(null)}
        title={restoreStyles ? `Restore the global styles from ${releaseTime(restoreStyles.release.published_at)}?` : ""}
        confirmLabel="Restore to the draft"
        onConfirm={async () => {
          if (!restoreStyles) return
          const current = await getGlobalStyles()
          await restoreGlobalStyleVersion(restoreStyles.version, current.draft_revision)
          setRestored({ when: releaseTime(restoreStyles.release.published_at), groups: groupsLabel(stylesOf(restoreStyles.release)?.groups) })
        }}
      >
        <p>The draft takes these styles for everyone. Readers see them after you publish the site design.</p>
      </ConfirmDialog>
    </div>
  )
}

function LoadingHistory() {
  return (
    <div className="site-editor" aria-busy="true">
      <header className="site-editor__head">
        <div className="site-editor__title">
          <h1>History</h1>
        </div>
      </header>
      <div className="site-editor-releases" aria-hidden="true">
        {["220px", "180px", "240px"].map((width) => (
          <div key={width} className="site-editor-release">
            <Skeleton width={120} height={12} />
            <Skeleton width={width} height={10} />
          </div>
        ))}
      </div>
    </div>
  )
}
