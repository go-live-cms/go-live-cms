import { useEffect, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import PostStatus from "@gl-admin/components/ui/PostStatus"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import { ChevronRightIcon, DocumentIcon, PageIcon, PencilIcon, UploadIcon } from "@gl-admin/components/ui/icons"
import { Byline, LastEdited } from "@gl-admin/components/content/PostMeta"
import { getPostCounts, getPosts } from "@gl-admin/lib/api/posts"
import { getMedia } from "@gl-admin/lib/api/media"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { canCreateContent, isContentModerator } from "@gl-admin/lib/roles"
import { useAuthUser } from "@gl-admin/lib/hooks/useAuthUser"
import { useSiteSettings } from "@gl-admin/lib/hooks/useSiteSettings"
import { ACTIVE_STATUSES } from "@gl-admin/lib/contentList"
import type { Post } from "@gl-admin/lib/api/types"
import "@gl-admin/assets/styles/pages/home.scss"

// Home (#9, #340): quick actions, the posts you were working on, drafts and counts.
// The design's "Needs attention" and "Activity" sections, presence on the recent cards
// and "from a template" wait for #324, #326, #325, #323 and #322.

export function greeting(date: Date = new Date()): string {
  const h = date.getHours()
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"
}

type HomeData = {
  recent: Post[]
  drafts: Post[]
  counts: { published: number; drafts: number; pages: number; media: number }
}

export default function Dashboard() {
  const { baseTitle } = useGoLive()
  const user = useAuthUser()
  const settings = useSiteSettings()
  const [data, setData] = useState<HomeData | null>(null)
  const [error, setError] = useState<unknown>(null)
  const canCreate = canCreateContent(user?.role)
  // Contributors' Home is about their own posts; editors see the whole site's.
  const own = !isContentModerator(user?.role)
  const mine = own && user?.id ? { user_id: user.id } : {}

  useEffect(() => {
    document.title = `${baseTitle} Home`
  }, [baseTitle])

  useEffect(() => {
    let live = true
    const list = { with_meta: true, meta_level: "basic", sort: "changed_at", order: "desc" } as const
    Promise.all([
      getPosts({ ...list, ...mine, status: ACTIVE_STATUSES, limit: 3 }),
      getPosts({ ...list, ...mine, type: "post", status: "draft", limit: 5 }),
      getPostCounts({ type: "post", ...mine }),
      getPostCounts({ type: "page", ...mine }),
      getMedia({ limit: 1 }),
    ])
      .then(([recent, drafts, posts, pages, media]) => {
        if (!live) return
        setData({
          recent: recent.data,
          drafts: drafts.data,
          counts: {
            published: posts.counts.published ?? 0,
            drafts: posts.counts.draft ?? 0,
            pages: (pages.counts.published ?? 0) + (pages.counts.draft ?? 0),
            media: media.meta.total ?? 0,
          },
        })
      })
      .catch((e) => live && setError(e))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.role])

  const firstName = (user?.full_name || user?.username || "").trim().split(/\s+/)[0]
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })

  return (
    <div className="gl-home">
      <header className="gl-home__header">
        <h1>
          {greeting()}
          {firstName && `, ${firstName}`}
        </h1>
        <p>
          {today}
          {settings?.site_title && ` · ${settings.site_title}`}
        </p>
      </header>

      {canCreate && (
        <section aria-label="Create" className="gl-home__create">
          <QuickAction to="/content/post/new" icon={<PencilIcon />} accent title="New post" detail="Start a blank post" />
          <QuickAction to="/content/page/new" icon={<PageIcon />} title="New page" detail="For About, Pricing, Docs" />
          <QuickAction to="/media" icon={<UploadIcon />} title="Upload media" detail="Images, video and files" />
        </section>
      )}

      {error ? (
        <EmptyState variant="error" icon="close" title="Couldn't load your content" description={errorMessage(error)} />
      ) : (
        <>
          <section className="gl-home__section" aria-labelledby="home-recent" aria-busy={!data || undefined}>
            <h2 id="home-recent">Continue where you left off</h2>
            {data && data.recent.length === 0 ? (
              <EmptyState compact icon={<DocumentIcon size={24} />} title="Nothing to continue yet" description="Posts and pages you edit show up here." />
            ) : (
              <div className="gl-home__recent">
                {(data?.recent ?? [null, null, null]).map((post, i) => (
                  <RecentCard key={post?.id ?? i} post={post} />
                ))}
              </div>
            )}
          </section>

          <div className="gl-home__columns">
            <section className="gl-home__section" aria-labelledby="home-drafts" aria-busy={!data || undefined}>
              <div className="gl-home__section-heading">
                <h2 id="home-drafts">{own ? "Your drafts" : "Drafts"}</h2>
                <Link to={own ? "/content/post?view=mine" : "/content/post?view=draft"} className="gl-home__more">
                  View all
                </Link>
              </div>
              {data && data.drafts.length === 0 ? (
                <EmptyState compact title="No drafts" description="Every post is published or archived." />
              ) : (
                <ul className="gl-home__list">
                  {(data?.drafts ?? [null, null, null]).map((post, i) => (
                    <li key={post?.id ?? i}>
                      {post ? (
                        <Link to={`/content/edit/${post.id}`} className="gl-home__row">
                          <span className="gl-home__row-text">
                            <span className="gl-home__row-title">{post.title || "Untitled"}</span>
                            <span className="gl-home__row-detail">
                              <LastEdited post={post} phrase />
                            </span>
                          </span>
                          <Byline post={post} size={20} />
                          <ChevronRightIcon className="gl-home__chevron" />
                        </Link>
                      ) : (
                        <span className="gl-home__row">
                          <Skeleton shape="text" width="60%" />
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="gl-home__section" aria-labelledby="home-counts">
              <h2 id="home-counts">At a glance</h2>
              <dl className="gl-home__counts">
                <Count label={own ? "Your published posts" : "Published posts"} value={data?.counts.published} to={own ? "/content/post?view=mine" : "/content/post?view=published"} />
                <Count label={own ? "Your drafts" : "Drafts"} value={data?.counts.drafts} to={own ? "/content/post?view=mine" : "/content/post?view=draft"} />
                <Count label={own ? "Your pages" : "Pages"} value={data?.counts.pages} to="/content/page" />
                <Count label="Media files" value={data?.counts.media} to="/media" />
              </dl>
            </section>
          </div>
        </>
      )}
    </div>
  )
}

function QuickAction({ to, icon, title, detail, accent = false }: { to: string; icon: ReactNode; title: string; detail: string; accent?: boolean }) {
  return (
    <Link to={to} className="gl-home__action">
      <span className={`gl-home__action-icon${accent ? " gl-home__action-icon--accent" : ""}`} aria-hidden="true">
        {icon}
      </span>
      <span className="gl-home__action-text">
        <span className="gl-home__action-title">{title}</span>
        <span className="gl-home__action-detail">{detail}</span>
      </span>
    </Link>
  )
}

function RecentCard({ post }: { post: Post | null }) {
  if (!post) {
    return (
      <div className="gl-home__card" aria-hidden="true">
        <Skeleton shape="pill" />
        <Skeleton shape="text" width="80%" />
        <Skeleton shape="text" width="40%" />
      </div>
    )
  }
  return (
    <Link to={`/content/edit/${post.id}`} className="gl-home__card">
      <PostStatus status={post.post_status} iconPath={post.post_status} />
      <span className="gl-home__card-title">{post.title || "Untitled"}</span>
      <span className="gl-home__card-meta">
        <Byline post={post} size={20} />
        <span>
          <LastEdited post={post} phrase />
        </span>
      </span>
    </Link>
  )
}

function Count({ label, value, to }: { label: string; value: number | undefined; to: string }) {
  return (
    <div className="gl-home__count">
      <dt>
        <Link to={to}>{label}</Link>
      </dt>
      <dd>{value === undefined ? <Skeleton width={32} height={24} /> : value}</dd>
    </div>
  )
}
