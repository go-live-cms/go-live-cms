import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import { getPostCounts, getPosts } from "@gl-admin/lib/api/posts"
import { getPostTypes } from "@gl-admin/lib/api/postTypes"
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table"
import Pagination from "@gl-admin/components/ui/Pagination"
import PostStatus from "@gl-admin/components/ui/PostStatus"
import PostType from "@gl-admin/components/ui/PostType"
import Tabs from "@gl-admin/components/ui/Tabs"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import { DocumentIcon, PlusIcon } from "@gl-admin/components/ui/icons"
import { Byline, LastEdited } from "@gl-admin/components/content/PostMeta"
import { AccessCell, ListHeader, RowActionsCell, SortMenu } from "@gl-admin/components/content/ListParts"
import Pages from "@gl-admin/pages/Pages"
import NotFound from "@gl-admin/pages/NotFound"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { canCreateContent, isContentModerator, type PermissionUser } from "@gl-admin/lib/roles"
import { useAuthUser } from "@gl-admin/lib/hooks/useAuthUser"
import { useSiteSettings } from "@gl-admin/lib/hooks/useSiteSettings"
import {
  SORT_OPTIONS,
  findSort,
  findTab,
  listTabs,
  postAccess,
  tabCount,
  totalCount,
  type StatusCounts,
} from "@gl-admin/lib/contentList"
import { postPath } from "@/lib/seo"
import type { ApiMeta, Post, PostType as PostTypeInfo } from "@gl-admin/lib/api/types"
import "@gl-admin/assets/styles/pages/content-list.scss"

// The posts list (#340): status tabs with counts, sort, status pills, byline avatars and
// last edited; contributors get a "Your access" column. Hierarchical types (Pages) get
// the tree in Pages.tsx instead.
//
// Hidden until their issues land: search and the Author / Category / Tag filters, bulk
// selection and actions, Import (#150), Trash (#327), Scheduled (#147), "Changes not
// published" (#326) and the Category column.

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

function PostsList({ typeName, postType, title }: ListProps) {
  const navigate = useNavigate()
  const { baseTitle } = useGoLive()
  const user = useAuthUser()
  const role = user?.role
  const moderator = isContentModerator(role)
  const canCreate = canCreateContent(role)
  const settings = useSiteSettings()
  const [params, setParams] = useSearchParams()
  const tabs = listTabs(role)
  const tab = findTab(tabs, params.get("view"))
  const sort = findSort(params.get("sort"))
  const { plural, singular } = typeLabels(typeName, postType, title)
  const newType = typeName || "post"

  const [counts, setCounts] = useState<StatusCounts | null>(null)
  const [mineCounts, setMineCounts] = useState<StatusCounts | null>(null)
  // Counts that failed to load leave the tabs without numbers (not "0", not the empty state).
  const [countsFailed, setCountsFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const retryList = useRef<() => void>(() => {})

  useEffect(() => {
    document.title = `${baseTitle} ${plural}`
  }, [baseTitle, plural])

  useEffect(() => {
    let live = true
    getPostCounts({ type: typeName })
      .then((r) => live && setCounts(r.counts))
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

  const changed = () => {
    setRefresh((n) => n + 1)
    retryList.current()
  }

  const setParam = (key: string, value: string, fallback: string) => {
    const next = new URLSearchParams(params)
    if (value === fallback) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }

  const query = useMemo(
    () => ({
      type: typeName || "",
      status: tab.status,
      user_id: tab.mine && user?.id ? String(user.id) : "",
      sort: sort.sort,
      order: sort.order,
    }),
    [typeName, tab.status, tab.mine, user?.id, sort.sort, sort.order]
  )

  const fetchData = useCallback(async ({ limit, offset, ...q }: ApiMeta & typeof query) => {
    const filtered = Object.fromEntries(Object.entries(q).filter(([, v]) => v !== ""))
    const response = await getPosts({ limit, offset, with_meta: true, meta_level: "basic", ...filtered })
    return { data: response.data, total: response.meta.total || 0 }
  }, [])

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
            <Link to={`/content/edit/${row.id}`} className="gl-content-list__link">
              {row.title || "Untitled"}
            </Link>
            <span className="gl-content-list__path">{postPath(row, structure)}</span>
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
      render: (_, row) => <PostStatus status={row?.post_status || null} iconPath={row?.post_status || null} />,
    },
    { key: "authors", name: "Authors", width: "6rem", render: (_, row) => <Byline post={row} /> },
    { key: "changed_at", name: "Last edited", width: "8.5rem", render: (_, row) => <LastEdited post={row} /> },
  ]
  if (!typeName) {
    columns.splice(2, 0, {
      key: "post_type",
      name: "Type",
      width: "8rem",
      render: (_, row) => <PostType type={row?.post_type || null} iconPath={row?.post_type || null} />,
    })
  }
  if (!moderator) {
    columns.push({ key: "user_id", name: "Your access", width: "16rem", render: (_, row) => <AccessCell post={row} user={user} /> })
  }
  columns.push({
    key: "id",
    name: "Actions",
    width: moderator ? "3.5rem" : "8.5rem",
    render: (_, row) => row && <RowActionsCell post={row} user={user} onOpen={open} onChanged={changed} noun={singular} />,
  })

  const newButton = canCreate && (
    <Button variant="primary" icon={<PlusIcon />} onClick={() => navigate(`/content/${newType}/new`)}
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
              <Button variant="primary" size="lg" onClick={() => navigate(`/content/${newType}/new`)}>
                Write a {singular}
              </Button>
            )
          }
        />
      </section>
    )
  }

  return (
    <section className={`gl-content-list${moderator ? "" : " gl-content-list--contributor"}`}>
      <ListHeader title={plural} actions={newButton} />

      {!moderator && (
        <Notice tone="info">
          As a contributor you can edit the {plural.toLowerCase()} you own, at any status. Editors publish them. Everything
          else opens view-only, including {plural.toLowerCase()} that only list you as an author.
        </Notice>
      )}

      <Tabs
        label="Views"
        activation="manual"
        tabs={tabs.map((t) => ({ id: t.id, label: t.label, count: countsFailed ? undefined : tabCount(t, counts, mineCounts) }))}
        value={tab.id}
        onChange={(id) => setParam("view", id, tabs[0].id)}
      />

      <div className="gl-content-list__toolbar">
        <SortMenu value={sort.id} onChange={(id) => setParam("sort", id, SORT_OPTIONS[0].id)} />
      </div>

      <Pagination fetchData={fetchData} query={query} limitOptions={[10, 25, 50]}>
        {({ data, loading, error, retry }) => {
          retryList.current = retry
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
            return (
              <EmptyState
                compact
                icon={<DocumentIcon size={24} />}
                title={`Nothing in ${tab.label}`}
                description={`No ${plural.toLowerCase()} here right now.`}
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
                <Table aria-label={plural} columns={columns} data={data} loading={loading} />
              </div>
              <PostCards posts={loading ? null : data} structure={structure} user={moderator ? null : user} />
            </>
          )
        }}
      </Pagination>
    </section>
  )
}

// Phone width: the table becomes a list of links (the 375 board).
// `user` is set for contributors, whose cards also say whether they can edit.
function PostCards({ posts, structure, user }: { posts: Post[] | null; structure: "id" | "slug"; user: PermissionUser | null }) {
  if (!posts) return null
  return (
    <ul className="gl-post-cards">
      {posts.map((post) => (
        <li key={post.id}>
          <Link to={`/content/edit/${post.id}`} className="gl-post-cards__link">
            <span className="gl-post-cards__title">{post.title || "Untitled"}</span>
            <span className="gl-post-cards__meta">
              <PostStatus status={post.post_status} iconPath={post.post_status} />
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

