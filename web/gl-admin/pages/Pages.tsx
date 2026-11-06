import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import { getPosts } from "@gl-admin/lib/api/posts"
import { getCollaborations } from "@gl-admin/lib/api/postAccess"
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table"
import PostStatus from "@gl-admin/components/ui/PostStatus"
import Tabs from "@gl-admin/components/ui/Tabs"
import Button from "@gl-admin/components/ui/Button"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import { PageIcon, PlusIcon } from "@gl-admin/components/ui/icons"
import { LastEdited } from "@gl-admin/components/content/PostMeta"
import { AccessCell, ListHeader, RowActionsCell } from "@gl-admin/components/content/ListParts"
import { useNewPostChooser } from "@gl-admin/components/content/NewPostDialog"
import Pill from "@gl-admin/components/ui/Pill"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { updateSettings } from "@gl-admin/lib/api/settings"
import { authManager } from "@gl-admin/lib/auth"
import { canCreateContent, isContentModerator } from "@gl-admin/lib/roles"
import { FRONT_PAGE_BADGE, canSetFrontPage, isFrontPage } from "@gl-admin/lib/frontPage"
import { describeTemplate, missingTemplateNote, templateValue } from "@gl-admin/lib/pageTemplates"
import { usePageTemplates } from "@gl-admin/lib/hooks/usePageTemplates"
import { useAuthUser } from "@gl-admin/lib/hooks/useAuthUser"
import { useSiteSettings } from "@gl-admin/lib/hooks/useSiteSettings"
import { useListParams } from "@gl-admin/lib/hooks/useListParams"
import { MODERATOR_TABS, findTab, lastEdited, markCollaborations, tabCount, ALL_STATUSES } from "@gl-admin/lib/contentList"
import { buildPageTree, type PageRow } from "@gl-admin/lib/pageTree"
import { postPath } from "@/lib/seo"
import type { Post, PostType } from "@gl-admin/lib/api/types"
import "@gl-admin/assets/styles/pages/content-list.scss"

// The Pages list (#340): every page of a hierarchical type as a tree (post_parent,
// siblings by menu_order), or flat by last edited. The tree needs all of them, so they
// load in pages of 100 instead of through Pagination.
//
// New offers Blank or one of the type's post templates (#322), when it has any.
// A published page with changes not published (#326) shows that pill. The front page
// (#336) has a badge; admins set it from a published page's row menu ("Set as front
// page", PUT /settings), and unpublishing, archiving or trashing it asks first. The
// Template column (#336, moderators: contributors' rows come from with_meta lists,
// which don't carry it) names each page's layout in the active theme (lib/pageTemplates).
// Hidden until its issue lands: search.

// The moderators' status tabs: pages have no "My posts" view.
const TABS = MODERATOR_TABS

const PAGE_SIZE = 100
// 50 requests (5,000 pages) at most; a site that big needs search, not a tree.
const MAX_REQUESTS = 50

// `withAuthors` adds the byline (per-row subqueries); only contributors' "You're credited"
// note needs it.
async function loadAllPages(type: string, withAuthors: boolean): Promise<Post[]> {
  const all: Post[] = []
  for (let i = 0; i < MAX_REQUESTS; i++) {
    const { data, meta } = await getPosts({
      type,
      // Every status, the trash (#327) included: the tabs filter here.
      status: ALL_STATUSES,
      limit: PAGE_SIZE,
      offset: all.length,
      sort: "id",
      order: "asc",
      ...(withAuthors ? { with_meta: true, meta_level: "basic" } : {}),
    })
    all.push(...data)
    if (data.length < PAGE_SIZE || all.length >= (meta.total ?? 0)) break
  }
  return all
}

type PagesProps = { typeName: string; postType?: PostType }

export default function Pages({ typeName, postType }: PagesProps) {
  const navigate = useNavigate()
  const { baseTitle } = useGoLive()
  const user = useAuthUser()
  const moderator = isContentModerator(user?.role)
  const canCreate = canCreateContent(user?.role)
  const siteSettings = useSiteSettings()
  const structure = siteSettings?.post_url_structure ?? "id"
  // The front page (#336): the saved setting, then what "Set as front page" chose here.
  const [chosenFrontPage, setChosenFrontPage] = useState<number | null | undefined>(undefined)
  const frontPageId = chosenFrontPage !== undefined ? chosenFrontPage : (siteSettings?.front_page_id ?? null)
  const { templates } = usePageTemplates()
  const pageType = typeName === "page"
  const [params, setParam] = useListParams()
  const tab = findTab(TABS, params.get("view"))
  const layout = params.get("layout") === "list" ? "list" : "tree"
  const plural = postType?.label || "Pages"
  const singular = plural.replace(/s$/, "").toLowerCase()
  const newPost = useNewPostChooser({ postType: typeName, noun: singular, canCreate, canManage: moderator })

  const [pages, setPages] = useState<Post[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    document.title = `${baseTitle} ${plural}`
  }, [baseTitle, plural])

  useEffect(() => {
    let live = true
    setError(null)
    // Contributors' edit access grants (#321) mark someone else's page as editable.
    Promise.all([loadAllPages(typeName, !moderator), moderator ? [] : getCollaborations().catch(() => [] as number[])])
      .then(([all, granted]) => live && setPages(markCollaborations(all, granted)))
      .catch((e) => live && setError(e))
    return () => {
      live = false
    }
  }, [typeName, moderator, attempt])

  const reload = () => setAttempt((n) => n + 1)

  const counts = useMemo(() => {
    if (!pages) return null
    const c: Record<string, number> = {}
    for (const p of pages) c[p.post_status] = (c[p.post_status] ?? 0) + 1
    return c
  }, [pages])
  // The "Changes not published" tab (#326): a subset of the published pages.
  const changesCount = useMemo(() => (pages ? pages.filter((p) => p.has_unpublished_changes).length : null), [pages])

  const byId = useMemo(() => new Map((pages ?? []).map((p) => [p.id, p])), [pages])

  const rows = useMemo((): PageRow<Post>[] => {
    if (!pages) return []
    const statuses = tab.status.split(",")
    const shown = pages.filter((p) => statuses.includes(p.post_status) && (!tab.unpublishedChanges || p.has_unpublished_changes))
    if (layout === "tree") return buildPageTree(shown)
    return shown
      .sort((a, b) => Date.parse(lastEdited(b)) - Date.parse(lastEdited(a)) || b.id - a.id)
      .map((page) => ({ page, depth: 0, orphan: false }))
  }, [pages, tab.status, tab.unpublishedChanges, layout])

  const open = (post: Post) => navigate(`/content/edit/${post.id}`)

  const setFrontPage = async (page: Post) => {
    const token = authManager.getState().accessToken || undefined
    const saved = await updateSettings({ front_page_id: page.id }, token)
    setChosenFrontPage(saved.front_page_id ?? page.id)
  }

  const columns: TableColumnWithRender<PageRow<Post>>[] = [
    {
      key: "page",
      name: "Title",
      render: (_, row) => {
        if (!row) {
          return (
            <div className="gl-content-list__title">
              <Skeleton shape="text" width="50%" />
              <Skeleton shape="text" width={120} height={8} />
            </div>
          )
        }
        const { page, depth, orphan } = row
        const parent = orphan && page.post_parent ? byId.get(page.post_parent) : undefined
        return (
          <div className="gl-page-row" style={{ paddingLeft: `${Math.min(depth, 6) * 20}px` }}>
            {depth > 0 && (
              <span className="gl-page-row__branch" aria-hidden="true">
                └
              </span>
            )}
            <PageIcon className="gl-page-row__icon" />
            <div className="gl-content-list__title">
              <span className="gl-page-row__heading">
                <Link to={`/content/edit/${page.id}`} className="gl-content-list__link">
                  {page.title || "Untitled"}
                </Link>
                {isFrontPage(page, frontPageId) && (
                  <Pill tone="neutral" dot={false} className="gl-page-row__front">
                    {FRONT_PAGE_BADGE}
                  </Pill>
                )}
              </span>
              <span className="gl-content-list__path gl-content-list__path--mono">
                {postPath(page, structure)}
                {/* The parent is in another tab (or gone): say where the page lives. */}
                {orphan && layout === "tree" && (
                  <span className="gl-page-row__parent"> · {parent ? `in ${parent.title || "Untitled"}` : "parent missing"}</span>
                )}
              </span>
            </div>
            {depth > 0 && <span className="gl-content-list__sr">, level {depth + 1}</span>}
          </div>
        )
      },
    },
    {
      key: "depth",
      name: "Status",
      width: "9.5rem",
      render: (_, row) => (
        <PostStatus
          status={row?.page.post_status || null}
          iconPath={row?.page.post_status || null}
          unpublishedChanges={row?.page.has_unpublished_changes}
          publishAt={row?.page.publish_at}
          updateAt={row?.page.update_at}
        />
      ),
    },
  ]
  if (moderator && pageType) {
    columns.push({
      key: "template" as keyof PageRow<Post>,
      name: "Template",
      width: "8.5rem",
      render: (_, row) => {
        if (!row) return <Skeleton shape="text" width={64} />
        const shown = describeTemplate(templates, row.page.page_template)
        const note = shown.missing ? missingTemplateNote(templateValue(row.page.page_template), shown.label) : undefined
        return (
          <span className="gl-page-row__template" title={note ?? shown.description}>
            {shown.label}
            {note && <span className="gl-content-list__sr">. {note}</span>}
          </span>
        )
      },
    })
  }
  columns.push({ key: "orphan", name: "Last edited", width: "8.5rem", render: (_, row) => <LastEdited post={row?.page ?? null} /> })
  if (!moderator) {
    columns.push({
      key: "access" as keyof PageRow<Post>,
      name: "Your access",
      width: "16rem",
      render: (_, row) => <AccessCell post={row?.page ?? null} user={user} />,
    })
  }
  columns.push({
    key: "actions" as keyof PageRow<Post>,
    name: "Actions",
    width: moderator ? "3.5rem" : "8.5rem",
    render: (_, row) =>
      row && (
        <RowActionsCell
          post={row.page}
          user={user}
          onOpen={open}
          onChanged={reload}
          noun={singular}
          frontPage={{
            isFront: isFrontPage(row.page, frontPageId),
            onSet: canSetFrontPage(user, row.page, frontPageId) ? () => setFrontPage(row.page) : undefined,
          }}
        />
      ),
  })

  const newButton = canCreate && (
    <Button variant="primary" icon={<PlusIcon />} onClick={newPost.start}>
      New {singular}
    </Button>
  )

  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null

  if (error) {
    return (
      <section className="gl-content-list">
        <ListHeader title={plural} actions={newButton} />
        {newPost.dialog}
        <EmptyState
          variant="error"
          icon="close"
          title={`Couldn't load ${plural.toLowerCase()}`}
          description={errorMessage(error)}
          action={
            <Button variant="primary" onClick={reload}>
              Try again
            </Button>
          }
        />
      </section>
    )
  }

  if (total === 0) {
    return (
      <section className="gl-content-list">
        <ListHeader title={plural} actions={newButton} />
        {newPost.dialog}
        <EmptyState
          className="gl-content-list__empty"
          icon={<PageIcon size={24} />}
          title={`No ${plural.toLowerCase()} yet`}
          description={canCreate ? `Create your first ${singular}: an About, Pricing or Docs page.` : "Nothing has been created here yet."}
          action={
            canCreate && (
              <Button variant="primary" size="lg" onClick={newPost.start}>
                Create a {singular}
              </Button>
            )
          }
        />
      </section>
    )
  }

  const loading = pages === null

  return (
    <section className={`gl-content-list${moderator ? "" : " gl-content-list--contributor"}`}>
      <ListHeader title={plural} actions={newButton} />
      {newPost.dialog}

      <Tabs
        label="Views"
        activation="manual"
        tabs={TABS.map((t) => ({ id: t.id, label: t.label, count: tabCount(t, counts, null, changesCount) }))}
        value={tab.id}
        onChange={(id) => setParam("view", id, TABS[0].id)}
      />

      <div className="gl-content-list__toolbar">
        <fieldset className="gl-segmented">
          <legend className="gl-content-list__sr">Layout</legend>
          {(["tree", "list"] as const).map((value) => (
            <label key={value} className={`gl-segmented__option${layout === value ? " is-checked" : ""}`}>
              <input
                type="radio"
                name="pages-layout"
                value={value}
                checked={layout === value}
                onChange={() => setParam("layout", value, "tree")}
              />
              {value === "tree" ? "Tree" : "List"}
            </label>
          ))}
        </fieldset>
      </div>

      {loading && (
        <span role="status" className="gl-content-list__sr">
          Loading {plural.toLowerCase()}…
        </span>
      )}
      {!loading && rows.length === 0 ? (
        <EmptyState compact icon={<PageIcon size={24} />} title={`Nothing in ${tab.label}`} description={`No ${plural.toLowerCase()} here right now.`} />
      ) : (
        <Table
          aria-label={plural}
          columns={columns}
          data={rows}
          loading={loading}
          rowKey={(row) => row.page.id}
        />
      )}
    </section>
  )
}
