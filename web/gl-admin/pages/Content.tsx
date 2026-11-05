import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import { bulkPosts, getCreditedAuthors, getPostCounts, getPosts, searchPosts } from "@gl-admin/lib/api/posts"
import { getCollaborations } from "@gl-admin/lib/api/postAccess"
import { getAllTaxonomyTerms } from "@gl-admin/lib/api/taxonomies"
import { getPostTypes } from "@gl-admin/lib/api/postTypes"
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table"
import Pagination from "@gl-admin/components/ui/Pagination"
import PostStatus from "@gl-admin/components/ui/PostStatus"
import PostType from "@gl-admin/components/ui/PostType"
import Tabs from "@gl-admin/components/ui/Tabs"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import Modal from "@gl-admin/components/ui/Modal"
import { toast } from "@gl-admin/components/ui/Toast"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import { DocumentIcon, PlusIcon, SearchIcon } from "@gl-admin/components/ui/icons"
import { Byline, LastEdited } from "@gl-admin/components/content/PostMeta"
import ReviewRequestedPill from "@gl-admin/components/content/ReviewRequestedPill"
import { useNewPostChooser } from "@gl-admin/components/content/NewPostDialog"
import {
  AccessCell,
  BulkBar,
  BulkReportNotice,
  FilterMenu,
  ListHeader,
  RowActionsCell,
  SortMenu,
  type FilterOption,
} from "@gl-admin/components/content/ListParts"
import Pages from "@gl-admin/pages/Pages"
import NotFound from "@gl-admin/pages/NotFound"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { canCreateContent, isContentModerator, isTrashed, type PermissionUser } from "@gl-admin/lib/roles"
import { useAuthUser } from "@gl-admin/lib/hooks/useAuthUser"
import { useSiteSettings } from "@gl-admin/lib/hooks/useSiteSettings"
import { useListParams } from "@gl-admin/lib/hooks/useListParams"
import {
  BULK_LABELS,
  SORT_OPTIONS,
  bulkActions,
  bulkReport,
  filterEmptyMessage,
  filterQuery,
  findSort,
  findTab,
  hasFilters,
  listTabs,
  markCollaborations,
  postAccess,
  readListFilters,
  selectionAfterBulk,
  tabCount,
  totalCount,
  trashedPhrase,
  type BulkAction,
  type BulkReport,
  type StatusCounts,
} from "@gl-admin/lib/contentList"
import { postPath } from "@/lib/seo"
import type { ApiMeta, Post, PostType as PostTypeInfo } from "@gl-admin/lib/api/types"
import "@gl-admin/assets/styles/pages/content-list.scss"

// The posts list (#340): status tabs with counts, search (#145, the full-text index plus
// part of a title or slug, #327; ?q= in the URL, best match first, the tab and filters
// still apply), sort, status pills, byline avatars and last edited; contributors get a
// "Your access" column. Hierarchical types (Pages) get the tree in Pages.tsx instead. A
// published post with changes not published (#326) shows that pill, and editors get a
// tab for them. Scheduled posts (#147) have their tab and a "Scheduled · Nov 3" pill.
//
// #327: the Author (byline) / Category / Tag filters (?author= ?category= ?tag=, with
// the tabs, sort and search), bulk selection with the tab's actions (bulkActions) and a
// report of the posts the API refused, and the Trash tab (restore, delete permanently).
// Hidden until their issues land: Import (#150), the Category column, the byline bulk
// action (#319) and the design's bulk Archive.

type ContentProps = { title?: string }

export default function Content({ title }: ContentProps) {
  const { typeName } = useParams<{ typeName?: string }>()
  const [postTypes, setPostTypes] = useState<PostTypeInfo[]>([])
  const [postTypesLoaded, setPostTypesLoaded] = useState(false)

  useEffect(() => {
    getPostTypes()
      .then(({ data }) => setPostTypes(data ?? []))
      .catch(() => {})
      .finally(() => setPostTypesLoaded(true))
  }, [])

  const postType = postTypes.find((p) => p.name === typeName)

  // /content/<something that isn't a post type>
  if (typeName && postTypesLoaded && postTypes.length > 0 && !postType) return <NotFound />

  // Only posts and pages are known to be flat or a tree before /post-types answers;
  // wait for it for any other type rather than load the wrong list first.
  if (typeName && typeName !== "post" && typeName !== "page" && !postTypesLoaded) return null

  if (typeName && (postType?.hierarchical ?? typeName === "page")) {
    return <Pages typeName={typeName} postType={postType} />
  }
  return <PostsList typeName={typeName} postType={postType} title={title} />
}

function typeLabels(typeName: string | undefined, postType: PostTypeInfo | undefined, title?: string) {
  if (!typeName) return { plural: title || "Content", singular: "post" }
  const plural = postType?.label || typeName.charAt(0).toUpperCase() + typeName.slice(1) + "s"
  return { plural, singular: plural.replace(/s$/, "").toLowerCase() }
}

type ListProps = { typeName?: string; postType?: PostTypeInfo; title?: string }

// The filter params (#327) and the view (tab, sort, search) all live in the URL.
const FILTER_KEYS = ["author", "category", "tag", "review"] as const

// Review requested (#323): posts with an open review request (a contributor: their own).
const REVIEW_FILTER_OPTIONS: FilterOption[] = [{ id: "pending", label: "Review requested" }]

function PostsList({ typeName, postType, title }: ListProps) {
  const navigate = useNavigate()
  const { baseTitle } = useGoLive()
  const user = useAuthUser()
  const role = user?.role
  const moderator = isContentModerator(role)
  const canCreate = canCreateContent(role)
  const settings = useSiteSettings()
  const [params, setParam] = useListParams()
  const tabs = listTabs(role)
  const tab = findTab(tabs, params.get("view"))
  const inTrash = tab.status === "trash"
  const sort = findSort(params.get("sort"))
  const search = params.get("q")?.trim() ?? ""
  const filters = readListFilters(params)
  const filtered = hasFilters(filters)
  const { plural, singular } = typeLabels(typeName, postType, title)
  const newType = typeName || "post"
  // New: Blank or a template of this type (#322), when it has any.
  const newPost = useNewPostChooser({ postType: newType, noun: singular, canCreate, canManage: moderator })

  const [counts, setCounts] = useState<StatusCounts | null>(null)
  const [mineCounts, setMineCounts] = useState<StatusCounts | null>(null)
  const [changesCount, setChangesCount] = useState<number | null>(null)
  // Counts that failed to load leave the tabs without numbers (not "0", not the empty state).
  const [countsFailed, setCountsFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const retryList = useRef<() => void>(() => {})

  useEffect(() => {
    document.title = `${baseTitle} ${plural}`
  }, [baseTitle, plural])

  useEffect(() => {
    let live = true
    setCountsFailed(false)
    getPostCounts({ type: typeName })
      .then((r) => {
        if (!live) return
        setCounts(r.counts)
        setChangesCount(r.unpublished_changes ?? 0)
      })
      .catch(() => live && setCountsFailed(true))
    if (!moderator && user?.id) {
      getPostCounts({ type: typeName, user_id: user.id })
        .then((r) => live && setMineCounts(r.counts))
        .catch(() => live && setCountsFailed(true))
    }
    return () => {
      live = false
    }
  }, [typeName, moderator, user?.id, refresh])

  // The filters' options (#327): who is credited on posts of this type, and the
  // categories and tags. One that fails to load (or has nothing to offer) isn't shown.
  const [authorOptions, setAuthorOptions] = useState<FilterOption[]>([])
  const [categoryOptions, setCategoryOptions] = useState<FilterOption[]>([])
  const [tagOptions, setTagOptions] = useState<FilterOption[]>([])
  useEffect(() => {
    let live = true
    getCreditedAuthors({ type: typeName })
      .then((authors) => live && setAuthorOptions(authors.map((a) => ({ id: String(a.id), label: a.full_name || a.username }))))
      .catch(() => {})
    const terms = (type: string, set: (o: FilterOption[]) => void) =>
      getAllTaxonomyTerms(type)
        .then((all) => live && set(all.map((t) => ({ id: String(t.id), label: t.name }))))
        .catch(() => {})
    terms("category", setCategoryOptions)
    terms("tag", setTagOptions)
    return () => {
      live = false
    }
  }, [typeName])

  // The search box's text; the URL (and the request) follow it after a pause. The URL is
  // read when the timer fires, so a tab picked during the pause isn't overwritten.
  const [searchText, setSearchText] = useState(search)
  const [, setSearchParams] = useSearchParams()
  const latestParams = useRef(params)
  latestParams.current = params
  useEffect(() => {
    if (searchText.trim() === search) return
    const id = setTimeout(() => {
      const next = new URLSearchParams(latestParams.current)
      if (searchText.trim()) next.set("q", searchText.trim())
      else next.delete("q")
      setSearchParams(next, { replace: true })
    }, 400)
    return () => clearTimeout(id)
  }, [searchText])
  // Back / Forward (or a link) changed ?q: the box follows.
  useEffect(() => {
    setSearchText((text) => (text.trim() === search ? text : search))
  }, [search])

  const clearFilters = () => {
    const next = new URLSearchParams(params)
    FILTER_KEYS.forEach((k) => next.delete(k))
    setSearchParams(next, { replace: true })
  }

  const changed = () => {
    setRefresh((n) => n + 1)
    retryList.current()
  }

  const { author_id, terms, review } = filterQuery(filters)
  const query = useMemo(
    () => ({
      type: typeName || "",
      status: tab.status,
      user_id: tab.mine && user?.id ? String(user.id) : "",
      unpublished_changes: tab.unpublishedChanges ? "true" : "",
      author_id,
      terms,
      review,
      sort: sort.sort,
      order: sort.order,
      q: search,
    }),
    [typeName, tab.status, tab.mine, tab.unpublishedChanges, user?.id, author_id, terms, review, sort.sort, sort.order, search]
  )

  // A selection belongs to one page: another page (or page size) starts empty, so a bulk
  // action never reaches rows the user can't see. A reload of the same page keeps it.
  const [selected, setSelected] = useState<number[]>([])
  const lastPage = useRef<string | null>(null)
  // Contributors' edit access grants (#321) make someone else's post editable: the rows
  // are marked from GET /posts/collaborations (moderators edit everything anyway).
  const contributorRef = useRef(!moderator)
  contributorRef.current = !moderator
  const fetchData = useCallback(async ({ limit, offset, q, sort, order, ...filters }: ApiMeta & typeof query) => {
    const page = `${offset}:${limit}`
    if (lastPage.current !== null && lastPage.current !== page) setSelected([])
    lastPage.current = page
    const filtered = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== ""))
    // A search is ranked by the API, so it takes no sort.
    const [response, granted] = await Promise.all([
      q
        ? searchPosts({ limit, offset, q, ...filtered })
        : getPosts({ limit, offset, with_meta: true, meta_level: "basic", sort, order, ...filtered }),
      // Without it the rows just say view-only, as before; the editor reads the grant itself.
      contributorRef.current ? getCollaborations().catch(() => [] as number[]) : Promise.resolve([] as number[]),
    ])
    return { data: markCollaborations(response.data, granted), total: response.meta.total || 0 }
  }, [])

  // Bulk selection (#327): ids on the current page; cleared when the list changes.
  const available = bulkActions(user, tab)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [report, setReport] = useState<BulkReport | null>(null)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const pageRows = useRef<Post[]>([])
  useEffect(() => {
    setSelected([])
    setReport(null)
  }, [query])

  const runBulk = async (action: BulkAction) => {
    const ids = [...selected]
    if (ids.length === 0) return
    setBulkBusy(true)
    try {
      const answer = await bulkPosts(action, ids)
      const titles = new Map(pageRows.current.map((p) => [p.id, p.title || "Untitled"]))
      setReport(bulkReport(action, answer.results, titles, singular))
      setSelected(selectionAfterBulk(answer.results))
      setConfirmBulkDelete(false)
      if (answer.succeeded > 0) changed()
    } catch (e) {
      toast.error(errorMessage(e, `Couldn't ${BULK_LABELS[action].toLowerCase()} the selected ${plural.toLowerCase()}`))
    } finally {
      setBulkBusy(false)
    }
  }
  const onBulk = (action: BulkAction) => (action === "delete" ? setConfirmBulkDelete(true) : void runBulk(action))

  const open = (post: Post) => navigate(`/content/edit/${post.id}`)
  const structure = settings?.post_url_structure ?? "id"
  const total = totalCount(counts)

  const columns: TableColumnWithRender<Post>[] = [
    {
      key: "title",
      name: "Title",
      render: (_, row) =>
        row ? (
          <div className="gl-content-list__title">
            {isTrashed(row) ? (
              // In the trash: not editable, so not a link (restore it first).
              <span className="gl-content-list__link gl-content-list__link--trashed">{row.title || "Untitled"}</span>
            ) : (
              <Link to={`/content/edit/${row.id}`} className="gl-content-list__link">
                {row.title || "Untitled"}
              </Link>
            )}
            <span className="gl-content-list__path">{postPath(row, structure)}</span>
            <ReviewRequestedPill summary={row.review_request} meId={user?.id} />
          </div>
        ) : (
          <div className="gl-content-list__title">
            <Skeleton shape="text" width="60%" />
            <Skeleton shape="text" width={140} height={8} />
          </div>
        ),
    },
    {
      key: "post_status",
      name: "Status",
      width: "9.5rem",
      render: (_, row) => (
        <PostStatus
          status={row?.post_status || null}
          iconPath={row?.post_status || null}
          unpublishedChanges={row?.has_unpublished_changes}
          publishAt={row?.publish_at}
          updateAt={row?.update_at}
        />
      ),
    },
    { key: "authors", name: "Authors", width: "6rem", render: (_, row) => <Byline post={row} /> },
    inTrash
      ? {
          key: "deleted_at",
          name: "Trashed",
          width: "8.5rem",
          render: (_, row) => (row ? <span className="gl-content-list__muted">{trashedPhrase(row.deleted_at)}</span> : <Skeleton shape="text" width={80} />),
        }
      : { key: "changed_at", name: "Last edited", width: "8.5rem", render: (_, row) => <LastEdited post={row} /> },
  ]
  if (!typeName) {
    columns.splice(2, 0, {
      key: "post_type",
      name: "Type",
      width: "8rem",
      render: (_, row) => <PostType type={row?.post_type || null} iconPath={row?.post_type || null} />,
    })
  }
  if (!moderator && !inTrash) {
    columns.push({ key: "user_id", name: "Your access", width: "16rem", render: (_, row) => <AccessCell post={row} user={user} /> })
  }
  columns.push({
    key: "id",
    name: "Actions",
    width: moderator || inTrash ? "3.5rem" : "8.5rem",
    render: (_, row) => row && <RowActionsCell post={row} user={user} onOpen={open} onChanged={changed} noun={singular} />,
  })

  const newButton = canCreate && (
    <Button variant="primary" icon={<PlusIcon />} onClick={newPost.start}
      // The mobile bar has its own New post button.
      className={newType === "post" ? "gl-content-list__new" : undefined}
    >
      {moderator ? `New ${singular}` : "New draft"}
    </Button>
  )

  if (total === 0) {
    return (
      <section className="gl-content-list">
        <ListHeader title={plural} actions={newButton} />
        {newPost.dialog}
        <EmptyState
          className="gl-content-list__empty"
          icon={<DocumentIcon size={24} />}
          title={`No ${plural.toLowerCase()} yet`}
          description={
            canCreate
              ? `Write your first ${singular}.`
              : "Nothing has been written here yet. Your role can't create content; ask an administrator."
          }
          action={
            canCreate && (
              <Button variant="primary" size="lg" onClick={newPost.start}>
                Write a {singular}
              </Button>
            )
          }
        />
      </section>
    )
  }

  const setFilter = (key: (typeof FILTER_KEYS)[number]) => (id: string) => setParam(key, id, "")

  return (
    <section className={`gl-content-list${moderator ? "" : " gl-content-list--contributor"}`}>
      <ListHeader title={plural} actions={newButton} />
      {newPost.dialog}

      {!moderator && (
        <Notice tone="info">
          As a contributor you can edit the {plural.toLowerCase()} you own, at any status. Editors publish them. Everything
          else opens view-only, including {plural.toLowerCase()} that only list you as an author.
        </Notice>
      )}

      <Tabs
        label="Views"
        activation="manual"
        tabs={tabs.map((t) => ({
          id: t.id,
          label: t.label,
          count: countsFailed ? undefined : tabCount(t, counts, mineCounts, changesCount),
        }))}
        value={tab.id}
        onChange={(id) => setParam("view", id, tabs[0].id)}
      />

      {inTrash && (
        <p className="gl-content-list__note">
          Posts in the trash are off the site and out of every other list. Restore one to give it back the status it had
          {moderator ? "; delete it permanently to remove it and its revisions." : "."}
        </p>
      )}

      <div className="gl-content-list__toolbar">
        <label className="gl-content-list__search">
          <SearchIcon />
          <span className="gl-content-list__sr">Search {plural.toLowerCase()}</span>
          <input
            type="search"
            placeholder={`Search ${plural.toLowerCase()}`}
            value={searchText}
            maxLength={200}
            onChange={(e) => setSearchText(e.currentTarget.value)}
          />
        </label>
        <div className="gl-content-list__filters" role="group" aria-label="Filters">
          {authorOptions.length > 0 && (
            <FilterMenu label="Author" options={authorOptions} value={filters.author} onChange={setFilter("author")} />
          )}
          {categoryOptions.length > 0 && (
            <FilterMenu label="Category" options={categoryOptions} value={filters.category} onChange={setFilter("category")} />
          )}
          {tagOptions.length > 0 && <FilterMenu label="Tag" options={tagOptions} value={filters.tag} onChange={setFilter("tag")} />}
          {!inTrash && (
            <FilterMenu label="Review" options={REVIEW_FILTER_OPTIONS} value={filters.review} onChange={setFilter("review")} />
          )}
          {filtered && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>
        {search ? (
          <span className="gl-content-list__sorted">Best match first</span>
        ) : (
          <SortMenu value={sort.id} onChange={(id) => setParam("sort", id, SORT_OPTIONS[0].id)} />
        )}
      </div>

      {report && <BulkReportNotice report={report} onDismiss={() => setReport(null)} />}
      {selected.length > 0 && (
        <BulkBar count={selected.length} actions={available} busy={bulkBusy} onAction={onBulk} onClear={() => setSelected([])} />
      )}

      <Pagination fetchData={fetchData} query={query} limitOptions={[10, 25, 50]}>
        {({ data, loading, error, retry }) => {
          retryList.current = retry
          pageRows.current = data
          if (error) {
            return (
              <EmptyState
                variant="error"
                icon="close"
                title={`Couldn't load ${plural.toLowerCase()}`}
                description={errorMessage(error)}
                action={
                  <Button variant="primary" onClick={retry}>
                    Try again
                  </Button>
                }
              />
            )
          }
          if (!loading && data.length === 0) {
            if (search) {
              return (
                <EmptyState
                  compact
                  icon={<SearchIcon size={24} />}
                  title={`No ${plural.toLowerCase()} match “${search}”`}
                  description="Search looks at titles, slugs, descriptions, tags and published text. Try other words."
                  action={
                    <Button variant="secondary" onClick={() => setSearchText("")}>
                      Clear search
                    </Button>
                  }
                />
              )
            }
            if (filtered) {
              return (
                <EmptyState
                  compact
                  icon={<DocumentIcon size={24} />}
                  title={`No ${plural.toLowerCase()} match these filters`}
                  description={filterEmptyMessage(filters, tab.label)}
                  action={
                    <Button variant="secondary" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  }
                />
              )
            }
            return (
              <EmptyState
                compact
                icon={<DocumentIcon size={24} />}
                title={inTrash ? "The trash is empty" : `Nothing in ${tab.label}`}
                description={inTrash ? `${plural} you move to the trash wait here until you restore or delete them.` : `No ${plural.toLowerCase()} here right now.`}
              />
            )
          }
          return (
            <>
              {loading && (
                <span role="status" className="gl-content-list__sr">
                  Loading {plural.toLowerCase()}…
                </span>
              )}
              <div className="gl-content-list__table">
                <Table
                  aria-label={plural}
                  columns={columns}
                  data={data}
                  loading={loading}
                  selectable={available.length > 0 && !loading}
                  selectedKeys={selected}
                  onSelectionChange={(keys) => setSelected(keys.map(Number))}
                  rowLabel={(row) => row.title || "Untitled"}
                />
              </div>
              <PostCards posts={loading ? null : data} structure={structure} user={moderator ? null : user} />
            </>
          )
        }}
      </Pagination>

      <Modal
        isOpen={confirmBulkDelete}
        onClose={() => !bulkBusy && setConfirmBulkDelete(false)}
        role="alertdialog"
        size="small"
        title={`Delete ${selected.length} ${selected.length === 1 ? singular : plural.toLowerCase()} permanently?`}
        description="They and their revisions are deleted. This can't be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmBulkDelete(false)} disabled={bulkBusy}>
              Cancel
            </Button>
            <Button variant="danger" loading={bulkBusy} onClick={() => void runBulk("delete")}>
              Delete permanently
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </section>
  )
}

// Phone width: the table becomes a list of links (the 375 board).
// `user` is set for contributors, whose cards also say whether they can edit.
function PostCards({ posts, structure, user }: { posts: Post[] | null; structure: "id" | "slug"; user: PermissionUser | null }) {
  const me = useAuthUser()
  if (!posts) return null
  return (
    <ul className="gl-post-cards">
      {posts.map((post) => (
        <li key={post.id}>
          {/* A trashed post isn't editable, so its card isn't a link (#327); restore it from the table. */}
          <Link
            to={`/content/edit/${post.id}`}
            className="gl-post-cards__link"
            aria-disabled={isTrashed(post) || undefined}
            onClick={(e) => isTrashed(post) && e.preventDefault()}
          >
            <span className="gl-post-cards__title">{post.title || "Untitled"}</span>
            <span className="gl-post-cards__meta">
              <PostStatus
                status={post.post_status}
                iconPath={post.post_status}
                unpublishedChanges={post.has_unpublished_changes}
                publishAt={post.publish_at}
                updateAt={post.update_at}
              />
              <ReviewRequestedPill summary={post.review_request} meId={me?.id} />
              <Byline post={post} size={20} />
              <LastEdited post={post} />
            </span>
            {user && (
              <span className="gl-post-cards__access">{postAccess(user, post).canEdit ? "Can edit" : "View only"}</span>
            )}
            <span className="gl-content-list__sr">{postPath(post, structure)}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

