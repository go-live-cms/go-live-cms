import { useCallback, useEffect, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import Button, { IconButton, buttonClassName } from "@gl-admin/components/ui/Button"
import Menu, { MenuItem, MenuSeparator } from "@gl-admin/components/ui/Menu"
import Notice from "@gl-admin/components/ui/Notice"
import Pill from "@gl-admin/components/ui/Pill"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import { toast } from "@gl-admin/components/ui/Toast"
import { MoreIcon, PlusIcon, WarningIcon } from "@gl-admin/components/ui/icons"
import { ErrorPage } from "@gl-admin/components/errors/ErrorPages"
import PublishDesignDialog from "@gl-admin/components/site-editor/PublishDesignDialog"
import { ConfirmDialog, NewTemplateDialog } from "@gl-admin/components/site-editor/SiteDesignDialogs"
import { loadSiteDesignContext, type SiteDesignContext } from "@gl-admin/components/site-editor/siteContext"
import { MOBILE_QUERY } from "@gl-admin/components/sidebar/Sidebar"
import { useMediaQuery } from "@gl-admin/lib/hooks/useMediaQuery"
import { usePageTitle } from "@gl-admin/lib/hooks/usePageTitle"
import {
  TemplateExistsError,
  createSiteTemplate,
  deleteSiteTemplate,
  getGlobalStyles,
  getSiteDesignOverview,
  keepEditingSiteTemplate,
  resetSiteTemplate,
  type GlobalStylesResponse,
  type SiteDesignOverview,
  type SiteTemplate,
} from "@gl-admin/lib/api/siteDesign"
import { openDesignPreview } from "@gl-admin/lib/api/designPreview"
import { errorMessage } from "@gl-admin/lib/api/errors"
import {
  groupsLabel,
  partRows,
  previewPathFor,
  publishButtonLabel,
  resetConsequence,
  rowActions,
  takenSlugs,
  templateGroups,
  type OverviewInput,
  type OverviewRow,
} from "@gl-admin/lib/siteDesign"
import { plural } from "@gl-admin/utils/formatting"
import "@gl-admin/assets/styles/pages/site-editor.scss"

// The Site editor's overview (#493; the redesign canvas's "Site editor · overview" board,
// docs/design/theme-builder.md 13): every template and part of the active theme and what
// renders each kind of page now, the global styles, History, Preview site and Publish site
// design with its count. Admins only (the route's guard; the API's requireSiteAdmin). At
// phone width it reads and publishes; editing needs a larger screen (13.1).

type Confirm =
  | { kind: "reset"; row: SiteTemplate; name: string }
  | { kind: "delete"; row: SiteTemplate; name: string }
  | null

export default function SiteEditorPage() {
  usePageTitle("Site editor")
  const navigate = useNavigate()
  const phone = useMediaQuery(MOBILE_QUERY)
  const [context, setContext] = useState<SiteDesignContext | null>(null)
  const [overview, setOverview] = useState<SiteDesignOverview | null>(null)
  const [styles, setStyles] = useState<GlobalStylesResponse | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [publishOpen, setPublishOpen] = useState(false)
  const [newKind, setNewKind] = useState<"template" | "part" | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [busySlug, setBusySlug] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const [ctx, read, stylesRead] = await Promise.all([
        loadSiteDesignContext(),
        getSiteDesignOverview(),
        // The styles card reads its contrast flags and support; the rest of the page doesn't need it.
        getGlobalStyles().catch(() => null),
      ])
      setContext(ctx)
      setOverview(read)
      setStyles(stylesRead)
    } catch (error) {
      setLoadError(error)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback(async () => {
    try {
      setOverview(await getSiteDesignOverview())
      setStyles(await getGlobalStyles().catch(() => null))
    } catch {
      // The next action reads it again.
    }
  }, [])

  if (loadError) return <ErrorPage error={loadError} onRetry={() => void load()} />
  if (!context || !overview) return <LoadingOverview />

  const input: OverviewInput = {
    themeName: context.themeName,
    overview,
    shippedTemplates: context.shippedTemplates,
    shippedParts: context.shippedParts,
    vocabulary: context.vocabulary,
  }
  const groups = templateGroups(input)
  const parts = partRows(input)
  const count = overview.unpublished_changes
  const open = (id: number) => navigate(`/site-editor/templates/${id}`)

  const customize = async (row: OverviewRow) => {
    setBusySlug(`${row.kind}:${row.slug}`)
    try {
      const created = await createSiteTemplate({ kind: row.kind, slug: row.slug, from: row.customizeFrom })
      open(created.id)
    } catch (error) {
      if (error instanceof TemplateExistsError) open(error.id)
      else toast.error(`Couldn’t customize ${row.name}. ${errorMessage(error)}`)
    } finally {
      setBusySlug(null)
    }
  }

  const preview = async (row: OverviewRow) => {
    const tab = window.open("", `gl-site-preview-${row.slug}`)
    if (!tab) {
      toast.error("Your browser blocked the new tab. Allow pop-ups for this site and try again.")
      return
    }
    try {
      await openDesignPreview(tab.name, previewPathFor(row.kind, row.slug) ?? "/")
    } catch (error) {
      tab.close()
      toast.error(`Couldn’t open the preview. ${errorMessage(error)}`)
    }
  }

  const previewSite = () => preview({ kind: "template", slug: "home" } as OverviewRow)

  const onAction = async (row: OverviewRow, id: string) => {
    const item = row.row
    if (id === "preview") return void preview(row)
    if (!item) return
    if (id === "edit") return open(item.id)
    if (id === "history") return navigate(`/site-editor/history?item=${item.id}`)
    // Discard goes through the item's editor (rule 9): it opens there and asks.
    if (id === "discard") return navigate(`/site-editor/templates/${item.id}?action=discard`)
    if (id === "reset") return setConfirm({ kind: "reset", row: item, name: row.name })
    if (id === "delete") return setConfirm({ kind: "delete", row: item, name: row.name })
    if (id === "keep-editing") {
      try {
        await keepEditingSiteTemplate(item.id)
        toast.success(`${row.name} is editable again. It won’t reset on publish.`)
        await refresh()
      } catch (error) {
        toast.error(errorMessage(error))
      }
    }
  }

  const taken = (kind: "template" | "part") => takenSlugs(kind, overview.templates, context.shippedParts)
  const stylesChanged = overview.global_styles_changed
  const stylesSupported = styles?.supported ?? true
  const contrastCount = styles?.contrast.length ?? 0

  return (
    <div className="site-editor">
      <header className="site-editor__head">
        <div className="site-editor__title">
          <h1>Site editor</h1>
          <p className="site-editor__sub">
            {context.themeName} · how your site looks. Changes stay drafts until you publish the site design.
          </p>
        </div>
        {!phone && (
          <Link to="/site-editor/history" className={buttonClassName("secondary", "lg")}>
            History
          </Link>
        )}
        {!phone && (
          <Button variant="secondary" size="lg" onClick={() => void previewSite()}>
            Preview site
          </Button>
        )}
        <Button variant="primary" size="lg" onClick={() => setPublishOpen(true)} disabled={count === 0} aria-label={publishButtonLabel(count)}>
          Publish site design
          {count > 0 && (
            <span className="site-editor__count" aria-hidden="true">
              {count}
            </span>
          )}
        </Button>
      </header>

      {phone && (
        <Notice tone="info">
          Use a larger screen to edit templates and styles.
        </Notice>
      )}

      <section className="site-editor__section" aria-labelledby="site-editor-templates">
        <div className="site-editor__section-head">
          <h2 id="site-editor-templates">Templates</h2>
          {!phone && (
            <Button variant="secondary" icon={<PlusIcon size={14} />} onClick={() => setNewKind("template")}>
              New page template
            </Button>
          )}
        </div>
        <p className="site-editor__help">
          Each page uses the most specific template there is. A customized template replaces the theme’s layout of the same
          kind; the others keep the theme’s.
        </p>
        <div className="site-editor__list">
          {groups.map((group) => (
            <div key={group.id} className="site-editor__group">
              <h3 className="site-editor__group-h">{group.label}</h3>
              <ul className="site-editor__rows">
                {group.rows.map((row) => (
                  <OverviewItem key={row.slug} row={row} phone={phone} busy={busySlug === `template:${row.slug}`} onCustomize={customize} onAction={onAction} />
                ))}
              </ul>
            </div>
          ))}
          <p className="site-editor__note">The 500 page always uses {context.themeName}’s error layout, so it still shows when the API is down.</p>
        </div>
      </section>

      <section className="site-editor__section" aria-labelledby="site-editor-parts">
        <div className="site-editor__section-head">
          <h2 id="site-editor-parts">Template parts</h2>
          {!phone && (
            <Button variant="secondary" icon={<PlusIcon size={14} />} onClick={() => setNewKind("part")}>
              New part
            </Button>
          )}
        </div>
        <ul className="site-editor__rows site-editor__list">
          {parts.map((row) => (
            <OverviewItem key={row.slug} row={row} phone={phone} busy={busySlug === `part:${row.slug}`} onCustomize={customize} onAction={onAction} />
          ))}
        </ul>
      </section>

      <section className="site-editor__card" aria-labelledby="site-editor-styles">
        <div className="site-editor__card-text">
          <div className="site-editor__card-title">
            <h2 id="site-editor-styles">Global styles</h2>
            {stylesChanged && <Pill tone="accent">Changes not published</Pill>}
          </div>
          {stylesSupported ? (
            <p className="site-editor__sub">
              {stylesChanged ? `${groupsLabel(overview.global_styles_groups)} changed.` : `Colours, fonts, sizes and spacing are ${context.themeName}’s or yours, as published.`}
            </p>
          ) : (
            <p className="site-editor__sub">
              {context.themeName} doesn’t read global styles: its colours and fonts are set in its code. Templates and parts still work.
            </p>
          )}
          {contrastCount > 0 && (
            <p className="site-editor__flag">
              <WarningIcon size={14} />
              {plural(contrastCount, "colour pair", "colour pairs")} below the contrast minimum
            </p>
          )}
        </div>
        {!phone &&
          (stylesSupported ? (
            <Link to="/site-editor/styles" className={buttonClassName("secondary", "lg")}>
              Edit styles
            </Link>
          ) : (
            <Button variant="secondary" size="lg" disabled>
              Edit styles
            </Button>
          ))}
      </section>

      {phone && (
        <Link to="/site-editor/history" className={buttonClassName("secondary", "lg", "site-editor__phone-history")}>
          History
        </Link>
      )}

      <PublishDesignDialog
        isOpen={publishOpen}
        onClose={() => setPublishOpen(false)}
        onPublished={() => void refresh()}
        onOpenItem={phone ? undefined : open}
        onOpenStyles={phone ? undefined : () => navigate("/site-editor/styles")}
        vocabulary={context.vocabulary}
      />
      <NewTemplateDialog
        isOpen={newKind !== null}
        onClose={() => setNewKind(null)}
        kind={newKind ?? "template"}
        themeName={context.themeName}
        taken={taken(newKind ?? "template")}
        onCreate={async ({ slug, title, from }) => {
          try {
            const created = await createSiteTemplate({ kind: newKind ?? "template", slug, title, from })
            open(created.id)
          } catch (error) {
            if (error instanceof TemplateExistsError) open(error.id)
            else throw error
          }
        }}
      />
      <ConfirmDialog
        isOpen={confirm?.kind === "reset"}
        onClose={() => setConfirm(null)}
        title={confirm ? `Reset ${confirm.name} to the theme default?` : ""}
        confirmLabel="Reset on publish"
        onConfirm={async () => {
          if (!confirm) return
          await resetSiteTemplate(confirm.row.id)
          await refresh()
        }}
      >
        {confirm && (
          <>
            <p>
              {resetConsequence(
                confirm.row.kind,
                confirm.row.slug,
                confirm.name,
                context.themeName,
                confirm.row.slug in (confirm.row.kind === "part" ? context.shippedParts : context.shippedTemplates)
              )}
            </p>
            <p className="gl-styles-dialog__hint">Until then it’s read-only, and Keep editing undoes this.</p>
          </>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={confirm?.kind === "delete"}
        onClose={() => setConfirm(null)}
        title={confirm ? `Delete ${confirm.row.kind === "part" ? "the part" : "the template"} ${confirm.name}?` : ""}
        confirmLabel={confirm?.row.kind === "part" ? "Delete part" : "Delete template"}
        danger
        onConfirm={async () => {
          if (!confirm) return
          await deleteSiteTemplate(confirm.row.id)
          toast.success(`${confirm.name} deleted`)
          await refresh()
        }}
      >
        <p>It was never published, so nothing on your site changes. This can’t be undone.</p>
      </ConfirmDialog>
    </div>
  )
}

function OverviewItem({
  row,
  phone,
  busy,
  onCustomize,
  onAction,
}: {
  row: OverviewRow
  phone: boolean
  busy: boolean
  onCustomize: (row: OverviewRow) => Promise<void>
  onAction: (row: OverviewRow, id: string) => Promise<void> | void
}) {
  const actions = rowActions(row.row)
  return (
    <li className="site-editor__row">
      <div className="site-editor__row-name">
        <span className="site-editor__row-title">
          {row.row && !phone ? <Link to={`/site-editor/templates/${row.row.id}`}>{row.name}</Link> : <span>{row.name}</span>}
          {row.tag && <span className="site-editor__tag">{row.tag}</span>}
        </span>
        <code className="site-editor__slug">{row.slug}</code>
      </div>
      <div className="site-editor__row-state">
        <span className="site-editor__row-line">
          {row.pill && <Pill tone={row.pill.tone}>{row.pill.label}</Pill>}
          {row.source && <span className="site-editor__source">{row.source}</span>}
        </span>
        {row.meta && <span className="site-editor__meta">{row.meta}</span>}
      </div>
      {!phone && (
        <div className="site-editor__row-actions">
          {row.row ? (
            <Link to={`/site-editor/templates/${row.row.id}`} className={buttonClassName("secondary", "md")} aria-label={`Edit ${row.name}`}>
              Edit
            </Link>
          ) : (
            <Button variant="secondary" onClick={() => void onCustomize(row)} loading={busy} aria-label={`Customize ${row.name}`}>
              Customize
            </Button>
          )}
          <Menu
            label={`More for ${row.name}`}
            placement="bottom-end"
            trigger={(props) => <IconButton {...props} variant="ghost" aria-label={`More for ${row.name}`} icon={<MoreIcon size={16} />} />}
          >
            {actions.map((action, index) => (
              <MenuGroupItem key={action.id} first={index === 0} previous={actions[index - 1]?.id} action={action} onSelect={() => void onAction(row, action.id)} />
            ))}
          </Menu>
        </div>
      )}
    </li>
  )
}

// Separators between the menu's groups, as the board draws them: open/view, then changes, then Delete.
const GROUP_OF: Record<string, number> = { edit: 0, preview: 0, history: 0, discard: 1, reset: 1, "keep-editing": 1, delete: 2 }

function MenuGroupItem({
  first,
  previous,
  action,
  onSelect,
}: {
  first: boolean
  previous?: string
  action: { id: string; label: string; disabled?: boolean; hint?: string; danger?: boolean }
  onSelect: () => void
}) {
  const separate = !first && previous && GROUP_OF[previous] !== GROUP_OF[action.id]
  return (
    <>
      {separate && <MenuSeparator />}
      <MenuItem onSelect={onSelect} disabled={action.disabled} danger={action.danger} description={action.hint}>
        {action.label}
      </MenuItem>
    </>
  )
}

function LoadingOverview() {
  return (
    <div className="site-editor" aria-busy="true">
      <header className="site-editor__head">
        <div className="site-editor__title">
          <h1>Site editor</h1>
        </div>
        <Skeleton width={180} height={36} />
      </header>
      <div className="site-editor__list" aria-hidden="true">
        {["38%", "30%", "44%", "26%"].map((width) => (
          <div key={width} className="site-editor__row">
            <Skeleton width={180} height={14} />
            <Skeleton width={width} height={12} />
            <Skeleton width={84} height={32} />
          </div>
        ))}
      </div>
    </div>
  )
}
