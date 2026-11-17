import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import type { Editor as TiptapEditor } from "@tiptap/core"
import Editor, { type EditorRef } from "@gl-admin/components/editor/Editor"
import BlockSettingsPanel from "@gl-admin/components/editor/ui/BlockSettingsPanel"
import type { SiteEditorBridge } from "@gl-admin/components/editor/extensions/SiteBlocks"
import { useCollabPresence } from "@gl-admin/components/editor/utils/useCollabPresence"
import { shouldWarnBeforeUnload, useBeforeUnloadWarning, useConnectionView } from "@gl-admin/components/editor/utils/connectionState"
import Button, { IconButton, buttonClassName } from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import Popover from "@gl-admin/components/ui/Popover"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import Tabs from "@gl-admin/components/ui/Tabs"
import { toast } from "@gl-admin/components/ui/Toast"
import { ChevronDownIcon, CloseIcon } from "@gl-admin/components/ui/icons"
import { ErrorPage } from "@gl-admin/components/errors/ErrorPages"
import PublishDesignDialog from "@gl-admin/components/site-editor/PublishDesignDialog"
import StylesPreview, { PREVIEW_PAGES, type PreviewPage } from "@gl-admin/components/site-editor/StylesPreview"
import SiteEditorTopBar, { type EditorView } from "@gl-admin/components/site-editor/SiteEditorTopBar"
import { ConfirmDialog } from "@gl-admin/components/site-editor/SiteDesignDialogs"
import { loadSiteDesignContext, type SiteDesignContext } from "@gl-admin/components/site-editor/siteContext"
import { MOBILE_QUERY } from "@gl-admin/components/sidebar/Sidebar"
import { useMediaQuery } from "@gl-admin/lib/hooks/useMediaQuery"
import { usePageTitle } from "@gl-admin/lib/hooks/usePageTitle"
import { authManager } from "@gl-admin/lib/auth"
import {
  TemplateExistsError,
  createSiteTemplate,
  deleteSiteTemplate,
  getSiteDesignOverview,
  getSiteTemplate,
  keepEditingSiteTemplate,
  listSiteTemplateVersions,
  resetSiteTemplate,
  type SiteDesignOverview,
  type SiteTemplate,
  type SiteTemplateVersion,
} from "@gl-admin/lib/api/siteDesign"
import { getPostsByType } from "@gl-admin/lib/api/posts"
import { getAllTaxonomyTerms } from "@gl-admin/lib/api/taxonomies"
import { errorMessage } from "@gl-admin/lib/api/errors"
import {
  NeverPublishedError,
  ResetVersionError,
  discardTemplateChanges,
  restoreTemplateVersion,
  startOverTemplate,
  type TemplateRestoreTarget,
} from "@gl-admin/lib/collaboration/templateRestore"
import {
  STARTER_PARTS,
  editorActions,
  editorPill,
  previewPathFor,
  previewPostTypeFor,
  resetConsequence,
  routeHasList,
  siteTemplateName,
  templatesUsingPart,
  releaseTime,
  usedInLabel,
  type DocLike,
  type RowAction,
} from "@gl-admin/lib/siteDesign"
import "@gl-admin/assets/styles/components/editor/post-editor.scss"
import "@gl-admin/assets/styles/components/editor/post-settings.scss"
import "@gl-admin/assets/styles/pages/site-editor.scss"

// The template and part editors (#493; the boards "Site editor · template" and "· template
// part", docs/design/theme-builder.md 7, 8, 9, 13). The post editor's bound editor on the
// template's own collab document (`template-<id>`, #490): same blocks, presence, server repairs
// and hard rules; only the document kind and the catalog's `contexts` differ (the Site group).
// Nothing is saved from here (rule 11): the collab server stores. Restore, Discard and Start
// over go through the editor (rule 9, templateRestore.ts); Reset and Keep editing only change
// the row's working state (section 9). Admins only: the route's guard, the API and the collab
// server, which closes a demoted admin's connection. Desktop only (13.1, open question 2).

type Confirm = "reset" | "discard" | "start-over" | "delete" | { restore: SiteTemplateVersion } | null

const STORED_DEBOUNCE_MS = 600
const ACK_TIMEOUT_MS = 10000

export default function SiteTemplateEditorPage() {
  const params = useParams()
  const id = Number(params.id)
  // A new id is a new editor: nothing of the previous one's state carries over.
  return <TemplateEditor key={id} id={id} />
}

function TemplateEditor({ id }: { id: number }) {
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams()
  const phone = useMediaQuery(MOBILE_QUERY)
  const [context, setContext] = useState<SiteDesignContext | null>(null)
  const [row, setRow] = useState<SiteTemplate | null>(null)
  const [overview, setOverview] = useState<SiteDesignOverview | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const [ctx, item, read] = await Promise.all([loadSiteDesignContext(), getSiteTemplate(id), getSiteDesignOverview()])
      setContext(ctx)
      setRow(item)
      setOverview(read)
    } catch (error) {
      setLoadError(error)
    }
  }, [id])
  useEffect(() => {
    void load()
  }, [load])

  // Stable, so the effects that read ?action= and ?restore= run once per value.
  const clearSearch = useCallback(
    (key: string) =>
      setSearch(
        (current) => {
          const next = new URLSearchParams(current)
          next.delete(key)
          return next
        },
        { replace: true }
      ),
    [setSearch]
  )
  const name = row && context ? siteTemplateName(row.kind, row.slug, context.vocabulary, row.title) : ""
  usePageTitle(name ? `Edit ${row?.kind === "part" ? "part" : "template"}: ${name}` : "Site editor")

  if (loadError) return <ErrorPage error={loadError} onRetry={() => void load()} />
  if (phone) {
    return (
      <div className="site-editor site-editor--narrow">
        <h1 className="gl-visually-hidden">{name || "Site editor"}</h1>
        <div className="site-editor__narrow-card">
          <strong>Use a larger screen to edit templates</strong>
          <span>You can review and publish the site design from the overview.</span>
          <Link to="/site-editor" className={buttonClassName("secondary", "lg")}>
            Back to Site editor
          </Link>
        </div>
      </div>
    )
  }
  if (!context || !row || !overview) return <LoadingEditor />
  // Another theme's row (a link kept from before a theme switch): its design is that theme's.
  if (row.theme_slug !== context.themeSlug) {
    return (
      <div className="site-editor">
        <h1>{name}</h1>
        <Notice tone="info" title={`This belongs to another theme (${row.theme_slug})`}>
          Customizations stay with their theme. Activate it again to edit this one.
        </Notice>
        <Link to="/site-editor" className={buttonClassName("secondary", "lg")}>
          Back to Site editor
        </Link>
      </div>
    )
  }
  return (
    <LoadedEditor
      context={context}
      row={row}
      setRow={setRow}
      overview={overview}
      setOverview={setOverview}
      name={name}
      search={search}
      clearSearch={clearSearch}
      navigate={navigate}
    />
  )
}

function LoadedEditor({
  context,
  row,
  setRow,
  overview,
  setOverview,
  name,
  search,
  clearSearch,
  navigate,
}: {
  context: SiteDesignContext
  row: SiteTemplate
  setRow: (row: SiteTemplate) => void
  overview: SiteDesignOverview
  setOverview: (overview: SiteDesignOverview) => void
  name: string
  search: URLSearchParams
  clearSearch: (key: string) => void
  navigate: ReturnType<typeof useNavigate>
}) {
  const id = row.id
  const isPart = row.kind === "part"
  const editorRef = useRef<EditorRef>(null)
  const [blockEditor, setBlockEditor] = useState<TiptapEditor | null>(null)
  const [view, setView] = useState<EditorView>("edit")
  const [settingsOpen, setSettingsOpen] = useState(true)
  const [tab, setTab] = useState<"item" | "block" | "history">("item")
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error" | null>(null)
  const [previewKey, setPreviewKey] = useState(0)
  const [publishOpen, setPublishOpen] = useState(false)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [busyNotice, setBusyNotice] = useState(false)
  const [starterDismissed, setStarterDismissed] = useState(false)

  // The working state decides whether the editor is editable: a reset waits for publish (9).
  const viewOnly = row.working_state === "reset"
  const { status: collabStatus, users: collabUsers, unsynced, unsyncedCount } = useCollabPresence(id, true, "template")
  const connection = useConnectionView(collabStatus, true)
  useBeforeUnloadWarning(shouldWarnBeforeUnload({ editable: !viewOnly, unsynced, offline: connection === "offline" || connection === "reconnecting" }))
  const signedIn = authManager.getState().user
  const me = signedIn ? { id: signedIn.id, name: signedIn.full_name || signedIn.username, src: signedIn.avatar } : undefined

  // ── What the server stored: the row, the count, the preview ───────────────────────────
  const refreshRow = useCallback(async () => {
    try {
      const [item, read] = await Promise.all([getSiteTemplate(id), getSiteDesignOverview()])
      setRow(item)
      setOverview(read)
    } catch {
      // The next store or action reads it again.
    }
  }, [id, setRow, setOverview])
  const storedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onStored = useCallback(() => {
    // The frame always shows what the server has (8.3): reload it after each store, anyone's.
    clearTimeout(storedTimer.current)
    storedTimer.current = setTimeout(() => {
      setPreviewKey((key) => key + 1)
      void refreshRow()
    }, STORED_DEBOUNCE_MS)
  }, [refreshRow])
  useEffect(() => () => clearTimeout(storedTimer.current), [])

  // ── Parts: the card's state and button, "Used in N templates" ─────────────────────────
  const overviewRef = useRef(overview)
  overviewRef.current = overview
  const openPart = useCallback(
    async (slug: string) => {
      const existing = overviewRef.current.templates.find((t) => t.kind === "part" && t.slug === slug)
      const from = `?from=${id}`
      if (existing) return navigate(`/site-editor/templates/${existing.id}${from}`)
      try {
        const shipped = slug in context.shippedParts
        const created = await createSiteTemplate({
          kind: "part",
          slug,
          from: shipped ? "theme" : (STARTER_PARTS as readonly string[]).includes(slug) ? "starter" : "blank",
        })
        navigate(`/site-editor/templates/${created.id}${from}`)
      } catch (error) {
        if (error instanceof TemplateExistsError) navigate(`/site-editor/templates/${error.id}${from}`)
        else toast.error(`Couldn’t open that part. ${errorMessage(error)}`)
      }
    },
    [context.shippedParts, id, navigate]
  )
  // Built once for the editor's lifetime: a new bridge would rebuild its extensions, which
  // remounts the bound editor. It reads the current overview and callbacks through refs.
  const openPartRef = useRef(openPart)
  openPartRef.current = openPart
  const contextRef = useRef(context)
  contextRef.current = context
  const bridge = useMemo<SiteEditorBridge>(
    () => ({
      openPart: (slug) => void openPartRef.current(slug),
      partStatus: (slug) => {
        const part = overviewRef.current.templates.find((t) => t.kind === "part" && t.slug === slug)
        if (part) {
          const pill = editorPill(part)
          return { detail: `Template part · ${pill.label.replace(/^Customized · /, "")}`, action: "Edit part" }
        }
        const { shippedParts, themeName } = contextRef.current
        const known = slug in shippedParts || (STARTER_PARTS as readonly string[]).includes(slug)
        return {
          detail: known ? `Template part · ${themeName}’s ${slug}` : "Template part · doesn’t exist yet",
          action: known ? "Customize part" : "Create part",
        }
      },
      routeHasList: routeHasList(row.kind, row.slug),
    }),
    // One row per mount (the page is keyed by id): its kind and slug never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const [usedIn, setUsedIn] = useState<string[] | null>(null)
  useEffect(() => {
    if (!isPart) return
    let live = true
    void (async () => {
      // Every customized template's working copy, then what the theme ships for the rest.
      const rows = overview.templates.filter((t) => t.kind === "template" && t.working_state === "custom")
      const docs = await Promise.all(
        rows.map(async (t) => ({ name: siteTemplateName("template", t.slug, context.vocabulary, t.title), doc: (await getSiteTemplate(t.id).catch(() => null))?.block_doc ?? null }))
      )
      const customized = new Set(rows.map((t) => t.slug))
      for (const [slug, shipped] of Object.entries(context.shippedTemplates)) {
        if (!customized.has(slug)) docs.push({ name: siteTemplateName("template", slug, context.vocabulary), doc: (shipped.doc ?? null) as DocLike })
      }
      if (live) setUsedIn(templatesUsingPart(row.slug, docs))
    })()
    return () => {
      live = false
    }
    // Read once per part opened: the list is informative, not live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPart, row.slug])

  // ── Restore, Discard, Start over (rule 9) ─────────────────────────────────────────────
  // The editor must be editable: a reset item's is read-only (section 9), so Keep editing
  // first, then wait for the editable editor to bind.
  const editableTarget = useCallback(async (): Promise<TemplateRestoreTarget> => {
    if (row.working_state === "reset") setRow(await keepEditingSiteTemplate(id))
    const deadline = Date.now() + ACK_TIMEOUT_MS
    for (;;) {
      const target = editorRef.current?.getRestoreTarget()
      if (target) return { ...target, templateId: id }
      if (Date.now() > deadline) throw new Error("The editor isn’t connected. Try again once it is.")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }, [id, row.working_state, setRow])

  const afterRestore = (result: { saved: boolean; dropped: number; template: SiteTemplate }, done: string) => {
    setRow(result.template)
    void refreshRow()
    toast.success(result.saved ? done : `${done} It’s saved as soon as the server confirms.`)
    if (result.dropped > 0) toast.info(`${result.dropped} block${result.dropped === 1 ? "" : "s"} of it can’t be shown here; kept in the template.`)
  }

  const runDiscard = async () => {
    // After a published reset, discard is Reset again: nothing goes through the editor.
    if (row.published_version_no != null && !row.published) {
      setRow(await resetSiteTemplate(id))
      void refreshRow()
      return
    }
    try {
      const result = await discardTemplateChanges(await editableTarget(), row)
      afterRestore(result, `${name} is back to its published version.`)
    } catch (error) {
      if (error instanceof NeverPublishedError) {
        setConfirm("delete")
        return
      }
      throw error
    }
  }

  const runStartOver = async () => {
    const result = await startOverTemplate(await editableTarget())
    afterRestore(result, `${name} starts over from ${context.themeName}’s version.`)
  }

  const runRestore = async (version: SiteTemplateVersion) => {
    try {
      const result = await restoreTemplateVersion(await editableTarget(), version.version_no)
      afterRestore(result, `${name} from ${releaseTime(version.created_at)} is in the working copy. Publish to put it live.`)
    } catch (error) {
      if (error instanceof ResetVersionError) throw new Error("That version reset it to the theme default. Use Reset to theme default instead.")
      throw error
    }
  }

  const keepEditing = async () => {
    setBusyNotice(true)
    try {
      setRow(await keepEditingSiteTemplate(id))
      void refreshRow()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusyNotice(false)
    }
  }

  // ?action=discard (the overview's row menu) and ?restore=N (History) open their dialog here.
  const pendingAction = search.get("action")
  const pendingRestore = search.get("restore")
  const [versions, setVersions] = useState<SiteTemplateVersion[] | null>(null)
  const loadVersions = useCallback(async () => {
    try {
      setVersions(await listSiteTemplateVersions(id))
    } catch {
      setVersions([])
    }
  }, [id])
  useEffect(() => {
    if (pendingAction === "discard") {
      setConfirm("discard")
      clearSearch("action")
    }
  }, [pendingAction, clearSearch])
  useEffect(() => {
    if (!pendingRestore) return
    const no = Number(pendingRestore)
    void listSiteTemplateVersions(id)
      .then((list) => {
        setVersions(list)
        const version = list.find((v) => v.version_no === no)
        if (version) setConfirm({ restore: version })
      })
      .catch(() => {})
      .finally(() => clearSearch("restore"))
  }, [pendingRestore, id, clearSearch])
  useEffect(() => {
    if (tab === "history") void loadVersions()
  }, [tab, loadVersions, row.published_version_no])

  const onAction = (action: RowAction["id"]) => {
    if (action === "history") {
      setSettingsOpen(true)
      setTab("history")
    } else if (action === "discard") setConfirm("discard")
    else if (action === "reset") setConfirm("reset")
    else if (action === "keep-editing") void keepEditing()
    else if (action === "delete") setConfirm("delete")
  }
  const actions = editorActions(row)

  const beforePublish = async () => {
    // The publish flushes the server, which needs every edit typed here first.
    await Promise.race([
      editorRef.current?.whenAcknowledged() ?? Promise.resolve(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Your latest edits aren’t on the server yet. Check the connection and try again.")), ACK_TIMEOUT_MS)),
    ])
  }

  // ── Preview pages ─────────────────────────────────────────────────────────────────────
  const [previewPages, setPreviewPages] = useState<PreviewPage[]>([])
  useEffect(() => {
    let live = true
    void (async () => {
      const type = previewPostTypeFor(row.kind, row.slug)
      let pages: PreviewPage[] = []
      if (isPart) pages = PREVIEW_PAGES.map((page) => ({ ...page }))
      else if (type) {
        const posts = await getPostsByType(type, { limit: 10 }).catch(() => null)
        pages = (posts?.data ?? [])
          .filter((post) => post.post_status === "published")
          .map((post) => ({ value: `/${post.post_type || type}/${post.id}`, label: post.title || `Untitled (${post.id})` }))
        if (pages.length === 0) pages = [{ value: "/", label: "Home (nothing published of this kind yet)" }]
      } else if (row.slug.startsWith("taxonomy-")) {
        const taxonomy = row.slug.slice("taxonomy-".length)
        const terms = await getAllTaxonomyTerms(taxonomy).catch(() => [])
        const path = terms[0] ? previewPathFor(row.kind, row.slug, { taxonomy, slug: terms[0].slug }) : null
        pages = path ? [{ value: path, label: terms[0].name }] : [{ value: "/", label: "Home" }]
      } else {
        const path = previewPathFor(row.kind, row.slug)
        pages = [{ value: path ?? "/", label: path === "/" ? "Home" : (path ?? "Home") }]
      }
      if (live) setPreviewPages(pages)
    })()
    return () => {
      live = false
    }
  }, [row.kind, row.slug, isPart])

  const pill = editorPill(row)
  const fromId = Number(search.get("from"))
  const fromRow = fromId ? overview.templates.find((t) => t.id === fromId) : null
  const back = fromRow ? { label: siteTemplateName(fromRow.kind, fromRow.slug, context.vocabulary, fromRow.title), to: `/site-editor/templates/${fromRow.id}` } : null
  const shipped = row.slug in (isPart ? context.shippedParts : context.shippedTemplates)
  const startedFromCode = !isPart && row.source === "starter" && !shipped && row.published_version_no == null && !starterDismissed
  const empty = !row.block_doc?.blocks_order?.length
  const showPreview = view !== "edit"
  // What Start over puts in (the API's default: the theme's shipped one, else core's starter).
  const startOverSource = shipped
    ? `${context.themeName}’s ${name} ${isPart ? "part" : "template"}`
    : row.slug.startsWith("custom-")
      ? `a block version of ${context.themeName}’s page`
      : `a block version of ${context.themeName}’s ${isPart ? row.slug : "layout"}`

  return (
    <div className={`post-editor post-editor--${connection} site-template-editor site-template-editor--${view}`}>
      <h1 className="gl-visually-hidden">{`Edit ${isPart ? "part" : "template"}: ${name}`}</h1>
      <SiteEditorTopBar
        kind={row.kind}
        name={name}
        pill={pill}
        viewOnly={viewOnly}
        saveStatus={saveStatus}
        connection={connection}
        unsyncedCount={unsyncedCount}
        collabUsers={collabUsers}
        me={me}
        onJumpToCursor={(clientIds) => editorRef.current?.jumpToCollaborator(clientIds) ?? false}
        view={view}
        onViewChange={setView}
        settingsOpen={settingsOpen}
        onSettingsToggle={() => setSettingsOpen((open) => !open)}
        actions={actions}
        onAction={onAction}
        publishCount={overview.unpublished_changes}
        onPublish={() => setPublishOpen(true)}
        back={back}
        usedIn={isPart ? <UsedInButton names={usedIn} themeName={context.themeName} /> : null}
      />

      {viewOnly && (
        <Notice
          tone="warning"
          live="status"
          inline
          className="post-editor__banner"
          title={`${name} will reset to the theme default when you publish`}
          actions={
            <Button variant="secondary" size="sm" onClick={() => void keepEditing()} loading={busyNotice}>
              Keep editing
            </Button>
          }
        >
          Your version stays in History.
        </Notice>
      )}
      {row.default_changed && !viewOnly && (
        <Notice
          tone="warning"
          inline
          className="post-editor__banner"
          title="Default changed since you customized"
          actions={
            <Button variant="secondary" size="sm" onClick={() => setConfirm("start-over")}>
              Start over from the theme default…
            </Button>
          }
        >
          {context.themeName} changed its {name} {isPart ? "part" : "template"}. Your version is unchanged, and nothing changes on its own.
        </Notice>
      )}
      {connection === "offline" && !viewOnly && (
        <Notice tone="warning" live="none" className="post-editor__banner" title="You're offline">
          Your edits wait in this tab and are sent when you're back online. Keep this tab open until then.
        </Notice>
      )}

      <div className="post-editor__body site-template-editor__body">
        <div className="post-editor__canvas site-template-editor__canvas" hidden={view === "preview"}>
          <div className="post-editor__document">
            {startedFromCode && (
              <Notice tone="info" className="post-editor__notice" onDismiss={() => setStarterDismissed(true)}>
                {name} used {context.themeName}’s code layout. Customizing starts from a block version, which may look a little
                different. Reset brings back the code layout.
              </Notice>
            )}
            {empty && !viewOnly && (
              <Notice
                tone="info"
                className="post-editor__notice"
                title={isPart ? `${name} is empty` : "This template is empty"}
                actions={
                  !isPart || shipped || (STARTER_PARTS as readonly string[]).includes(row.slug) ? (
                    <Button variant="secondary" size="sm" onClick={() => setConfirm("start-over")}>
                      Start from the theme default
                    </Button>
                  ) : undefined
                }
              >
                {isPart
                  ? "Templates that use it show nothing there. Type / to add blocks."
                  : "It can’t be published empty: that would blank every page it renders. Type / to add blocks."}
              </Notice>
            )}
            <div className="post-editor__content">
              <Editor
                ref={editorRef}
                templateId={id}
                templateKind={row.kind}
                siteBridge={bridge}
                readOnly={viewOnly}
                value=""
                onChange={() => {}}
                placeholder={isPart ? "Type / for blocks" : "Type / for blocks: the Site group comes first"}
                onEditorReady={setBlockEditor}
                onToggleBlockSettings={() => {
                  setSettingsOpen(true)
                  setTab((current) => (current === "block" ? "item" : "block"))
                }}
                onOpenBlockSettings={() => {
                  setSettingsOpen(true)
                  setTab("block")
                }}
                onSaveStart={() => setSaveStatus("saving")}
                onSaveSuccess={() => setSaveStatus("saved")}
                onSaveError={() => setSaveStatus("error")}
                onStored={onStored}
                onAccessChange={() => void refreshRow()}
              />
            </div>
            {isPart && <p className="site-editor__help">The editor stacks blocks; Split or Preview shows them as {context.themeName} lays them out.</p>}
          </div>
        </div>

        {showPreview && (
          <StylesPreview
            reloadKey={previewKey}
            pages={previewPages.length ? previewPages : [{ value: "/", label: "Home" }]}
            frameTitle={`Your site with this ${isPart ? "part" : "template"}`}
            note="The site renders this from what the server has stored, and reloads it after each store. It never shows the editor’s unsaved state."
            className="site-template-editor__preview"
          />
        )}

        {settingsOpen && (
          <aside aria-label={isPart ? "Part settings" : "Template settings"} className="post-settings post-settings--visible site-template-editor__settings">
            <div className="post-settings__header">
              <Tabs
                label="Settings sections"
                className="post-settings__tabs"
                value={tab === "block" && !blockEditor ? "item" : tab}
                onChange={(next) => setTab(next as typeof tab)}
                tabs={[
                  { id: "item", label: isPart ? "Part" : "Template" },
                  ...(blockEditor ? [{ id: "block", label: "Block" }] : []),
                  { id: "history", label: "History" },
                ]}
              />
              <IconButton size="sm" aria-label="Close settings" icon={<CloseIcon />} onClick={() => setSettingsOpen(false)} />
            </div>
            <div className="post-settings__content">
              {tab === "block" && blockEditor ? (
                <BlockSettingsPanel editor={blockEditor} />
              ) : tab === "history" ? (
                <VersionsPanel versions={versions} row={row} onRestore={(version) => setConfirm({ restore: version })} />
              ) : (
                <ItemPanel row={row} name={name} context={context} usedIn={usedIn} />
              )}
            </div>
          </aside>
        )}
      </div>

      <PublishDesignDialog
        isOpen={publishOpen}
        onClose={() => setPublishOpen(false)}
        onPublished={() => void refreshRow()}
        onOpenItem={(itemId) => {
          setPublishOpen(false)
          if (itemId !== id) navigate(`/site-editor/templates/${itemId}`)
        }}
        onOpenStyles={() => navigate("/site-editor/styles")}
        beforePublish={beforePublish}
        vocabulary={context.vocabulary}
      />
      <ConfirmDialog
        isOpen={confirm === "reset"}
        onClose={() => setConfirm(null)}
        title={`Reset ${name} to the theme default?`}
        confirmLabel="Reset on publish"
        onConfirm={async () => {
          setRow(await resetSiteTemplate(id))
          void refreshRow()
        }}
      >
        <p>{resetConsequence(row.kind, row.slug, name, context.themeName, shipped)}</p>
        <p className="gl-styles-dialog__hint">Until then it’s read-only, and Keep editing undoes this.</p>
      </ConfirmDialog>
      <ConfirmDialog isOpen={confirm === "discard"} onClose={() => setConfirm(null)} title={`Discard changes to ${name}?`} confirmLabel="Discard changes" danger onConfirm={runDiscard}>
        <p>{name} goes back to its published version, for everyone editing it. Edits since it was last published are lost.</p>
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={confirm === "start-over"}
        onClose={() => setConfirm(null)}
        title={`Start ${name} over from ${context.themeName}’s version?`}
        confirmLabel="Start over"
        onConfirm={runStartOver}
      >
        <p>
          Your working copy is replaced with {startOverSource}, for everyone editing it.
          Readers keep seeing your published version until you publish. Published versions stay in History.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={confirm === "delete"}
        onClose={() => setConfirm(null)}
        title={`Delete ${isPart ? "the part" : "the template"} ${name}?`}
        confirmLabel={isPart ? "Delete part" : "Delete template"}
        danger
        onConfirm={async () => {
          await deleteSiteTemplate(id)
          toast.success(`${name} deleted`)
          navigate("/site-editor")
        }}
      >
        <p>It was never published, so nothing on your site changes. This can’t be undone.</p>
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={!!confirm && typeof confirm === "object"}
        onClose={() => setConfirm(null)}
        title={confirm && typeof confirm === "object" ? `Restore ${name} from ${releaseTime(confirm.restore.created_at)}?` : ""}
        confirmLabel="Restore version"
        onConfirm={async () => {
          if (confirm && typeof confirm === "object") await runRestore(confirm.restore)
        }}
      >
        <p>
          It replaces the working copy for everyone editing it. Readers see it after you publish the site design. The current
          working copy isn’t kept unless it was published.
        </p>
      </ConfirmDialog>
    </div>
  )
}

function ItemPanel({ row, name, context, usedIn }: { row: SiteTemplate; name: string; context: SiteDesignContext; usedIn: string[] | null }) {
  const isPart = row.kind === "part"
  const source =
    row.source === "theme" ? `${context.themeName}’s ${isPart ? "part" : "template"}` : row.source === "starter" ? `A block version of ${context.themeName}’s layout` : "Blank"
  return (
    <div className="post-settings__fieldset">
      <div className="post-settings__field">
        <span className="post-settings__label">Name</span>
        <span>{name}</span>
      </div>
      <div className="post-settings__field">
        <span className="post-settings__label">Slug</span>
        <code className="site-editor__slug">{row.slug}</code>
        <small className="post-settings__hint">
          {isPart ? "Templates find a part by its slug." : row.slug.startsWith("custom-") ? "Pages store it, so it can’t change." : "The kind of page it renders."}
        </small>
      </div>
      <div className="post-settings__field">
        <span className="post-settings__label">Started from</span>
        <span>{source}</span>
      </div>
      <div className="post-settings__field">
        <span className="post-settings__label">Status</span>
        <span>{editorPill(row).label}</span>
        <small className="post-settings__hint">
          {row.published ? "Published. Changes go live with the next Publish site design." : "Not published: the theme’s default renders until you publish."}
        </small>
      </div>
      {row.slug.startsWith("custom-") && (
        <p className="post-settings__hint">It’s offered in a page’s Template field once the site design is published.</p>
      )}
      {isPart && (
        <div className="post-settings__field">
          <span className="post-settings__label">Used in</span>
          {usedIn === null ? <small className="post-settings__hint">Counting…</small> : <span>{usedIn.length ? usedIn.join(", ") : "No template yet"}</span>}
          <small className="post-settings__hint">Also on every page {context.themeName}’s own layouts render, in place of its {row.slug}.</small>
        </div>
      )}
    </div>
  )
}

function VersionsPanel({ versions, row, onRestore }: { versions: SiteTemplateVersion[] | null; row: SiteTemplate; onRestore: (version: SiteTemplateVersion) => void }) {
  if (versions === null) return <p className="post-settings__hint">Loading versions…</p>
  if (versions.length === 0) {
    return <p className="post-settings__hint">A version is saved each time the site design is published with this {row.kind} in it. None yet.</p>
  }
  return (
    <div className="site-editor-versions">
      <p className="post-settings__hint">A version is saved each time the site design is published with this {row.kind} in it.</p>
      <ol className="site-editor-versions__list">
        {versions.map((version) => (
          <li key={version.version_no} className="site-editor-versions__item">
            <span className="site-editor-versions__text">
              <span className="site-editor-versions__time">
                {releaseTime(version.created_at)}
                {version.current && <span className="site-editor__tag">Live</span>}
              </span>
              <small className="post-settings__hint">
                {version.published_by_name || "Someone"}
                {version.reset ? " · reset to the theme default" : ""}
              </small>
            </span>
            {!version.current && !version.reset && (
              <Button variant="secondary" size="sm" onClick={() => onRestore(version)} aria-label={`Restore the version from ${releaseTime(version.created_at)}`}>
                Restore…
              </Button>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

function UsedInButton({ names, themeName }: { names: string[] | null; themeName: string }) {
  if (names === null) return null
  return (
    <Popover
      label="Where this part is used"
      placement="bottom-start"
      trigger={(props) => (
        <Button {...props} variant="ghost" size="sm" className="site-editor-top-bar__used-in">
          {usedInLabel(names.length)}
          <ChevronDownIcon size={12} />
        </Button>
      )}
    >
      <div className="site-editor-used-in">
        <strong>{usedInLabel(names.length)}</strong>
        {names.length > 0 && (
          <ul>
            {names.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        )}
        <p className="post-settings__hint">Also on every page {themeName}’s own layouts render.</p>
      </div>
    </Popover>
  )
}

function LoadingEditor() {
  return (
    <div className="post-editor site-template-editor" aria-busy="true">
      <h1 className="gl-visually-hidden">Site editor</h1>
      <header className="editor-top-bar">
        <span className="editor-top-bar__save">Connecting…</span>
      </header>
      <div className="site-template-editor__loading" aria-hidden="true">
        <Skeleton height={52} />
        <Skeleton width="60%" height={28} />
        <Skeleton height={120} />
      </div>
    </div>
  )
}
