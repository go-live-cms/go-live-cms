import { useEffect, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import PostStatus from "@gl-admin/components/ui/PostStatus"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import Avatar from "@gl-admin/components/ui/Avatar"
import Button from "@gl-admin/components/ui/Button"
import { ChevronRightIcon, CheckIcon, DangerIcon, DocumentIcon, PageIcon, PencilIcon, UploadIcon, WarningIcon } from "@gl-admin/components/ui/icons"
import { Byline, LastEdited } from "@gl-admin/components/content/PostMeta"
import NewPostDialog from "@gl-admin/components/content/NewPostDialog"
import { getPostCounts, getPosts } from "@gl-admin/lib/api/posts"
import { getMedia } from "@gl-admin/lib/api/media"
import { getActivity, getContinueEditing, getNeedsAttention, type ActivityEvent, type ContinueEditingPost } from "@gl-admin/lib/api/activity"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { canCreateContent, isContentModerator } from "@gl-admin/lib/roles"
import { useAuthUser } from "@gl-admin/lib/hooks/useAuthUser"
import { useSiteSettings } from "@gl-admin/lib/hooks/useSiteSettings"
import { editedPhrase } from "@gl-admin/lib/contentList"
import { attentionItems, describeActivity, type AttentionItem } from "@gl-admin/lib/activityFeed"
import { formatFullDate } from "@gl-admin/utils/formatting"
import type { Post } from "@gl-admin/lib/api/types"
import "@gl-admin/assets/styles/pages/home.scss"

// Home (#9, #340, #324): quick actions, "Continue where you left off" (the posts you
// last worked on, from the activity log), "Needs attention" (failed scheduled publishes;
// for editors, images without alt text and posts with unpublished changes; requests for
// edit access to posts you own, or any post for editors, #321), the
// Activity feed, then drafts and counts. "New post" offers Blank or a template (#322,
// NewPostDialog, which is also where editors rename and delete templates). Still
// waiting: presence on the recent cards (who's editing now) and review requests (#323).

// Activity rows per page ("Show more" loads the next).
const ACTIVITY_PAGE = 8

export function greeting(date: Date = new Date()): string {
  const h = date.getHours()
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"
}

type HomeData = {
  recent: ContinueEditingPost[]
  drafts: Post[]
  // null: that count failed to load.
  counts: { published: number | null; changes: number | null; drafts: number | null; pages: number | null; media: number | null }
}

export default function Dashboard() {
  const { baseTitle } = useGoLive()
  const user = useAuthUser()
  const settings = useSiteSettings()
  const [data, setData] = useState<HomeData | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [choosing, setChoosing] = useState(false)
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
    // A count that fails shows a dash; only the post lists failing is an error.
    const optional = <T,>(p: Promise<T>) => p.catch(() => null)
    Promise.all([
      getContinueEditing({ limit: 3 }),
      getPosts({ ...list, ...mine, type: "post", status: "draft", limit: 5 }),
      optional(getPostCounts({ type: "post", ...mine })),
      optional(getPostCounts({ type: "page", ...mine })),
      optional(getMedia({ limit: 1 })),
    ])
      .then(([recent, drafts, posts, pages, media]) => {
        if (!live) return
        setData({
          recent,
          drafts: drafts.data,
          counts: {
            published: posts ? (posts.counts.published ?? 0) : null,
            changes: posts ? (posts.unpublished_changes ?? 0) : null,
            drafts: posts ? (posts.counts.draft ?? 0) : null,
            pages: pages ? (pages.counts.published ?? 0) + (pages.counts.draft ?? 0) : null,
            media: media ? (media.meta.total ?? 0) : null,
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
          <QuickAction onClick={() => setChoosing(true)} icon={<PencilIcon />} accent title="New post" detail="Blank or from a template" />
          <QuickAction to="/content/page/new" icon={<PageIcon />} title="New page" detail="For About, Pricing, Docs" />
          <QuickAction to="/media" icon={<UploadIcon />} title="Upload media" detail="Images, video and files" />
        </section>
      )}
      <NewPostDialog isOpen={choosing} onClose={() => setChoosing(false)} postType="post" noun="post" canManage={!own} />

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
            <NeedsAttentionSection userId={user?.id} moderator={!own} />
            <ActivitySection userId={user?.id} />
          </div>

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
                {/* Editors' to-do list (#326): it opens their Changes not published tab, which
                    contributors don't have (an editor publishes their changes). */}
                {!own && <Count label="Changes not published" value={data?.counts.changes} to="/content/post?view=changes" />}
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

// A link, or with onClick a button (New post opens the chooser, #322).
function QuickAction({
  to,
  onClick,
  icon,
  title,
  detail,
  accent = false,
}: { icon: ReactNode; title: string; detail: string; accent?: boolean } & ({ to: string; onClick?: never } | { onClick: () => void; to?: never })) {
  const content = (
    <>
      <span className={`gl-home__action-icon${accent ? " gl-home__action-icon--accent" : ""}`} aria-hidden="true">
        {icon}
      </span>
      <span className="gl-home__action-text">
        <span className="gl-home__action-title">{title}</span>
        <span className="gl-home__action-detail">{detail}</span>
      </span>
    </>
  )
  if (onClick) {
    return (
      <button type="button" className="gl-home__action" aria-haspopup="dialog" onClick={onClick}>
        {content}
      </button>
    )
  }
  return (
    <Link to={to} className="gl-home__action">
      {content}
    </Link>
  )
}

function RecentCard({ post }: { post: ContinueEditingPost | null }) {
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
      <PostStatus
        status={post.post_status}
        iconPath={post.post_status}
        unpublishedChanges={post.has_unpublished_changes}
        publishAt={post.publish_at}
        updateAt={post.update_at}
      />
      <span className="gl-home__card-title">{post.title || "Untitled"}</span>
      <span className="gl-home__card-meta">
        {post.schedule_failed && <span className="gl-home__card-alert">Scheduled publish failed ·</span>}
        <time className="gl-last-edited" dateTime={post.edited_at} title={formatFullDate(post.edited_at)}>
          {editedPhrase(post.edited_at)}
        </time>
      </span>
    </Link>
  )
}

// A section that loads on its own: a failure shows here, not over the whole page.
type Loadable<T> = { state: "loading" } | { state: "error"; error: unknown } | { state: "ready"; value: T }

const ATTENTION_ICONS: Record<AttentionItem["tone"], ReactNode> = {
  danger: <DangerIcon size={14} />,
  warning: <WarningIcon size={14} />,
  accent: <PencilIcon size={14} />,
  neutral: <DocumentIcon size={14} />,
}

function NeedsAttentionSection({ userId, moderator }: { userId?: number; moderator: boolean }) {
  const [items, setItems] = useState<Loadable<AttentionItem[]>>({ state: "loading" })

  useEffect(() => {
    let live = true
    setItems({ state: "loading" })
    getNeedsAttention()
      .then((needs) => live && setItems({ state: "ready", value: attentionItems(needs, new Date(), moderator) }))
      .catch((error) => live && setItems({ state: "error", error }))
    return () => {
      live = false
    }
  }, [userId, moderator])

  return (
    <section className="gl-home__section" aria-labelledby="home-attention" aria-busy={items.state === "loading" || undefined}>
      <h2 id="home-attention">Needs attention</h2>
      {items.state === "error" ? (
        <EmptyState compact variant="error" icon="close" title="Couldn't load what needs attention" description={errorMessage(items.error)} />
      ) : items.state === "ready" && items.value.length === 0 ? (
        <EmptyState compact icon={<CheckIcon size={24} />} title="All caught up" description="Failed scheduled posts, missing alt text, changes waiting to be published and requests for edit access show up here." />
      ) : (
        <ul className="gl-home__list gl-home__attention">
          {(items.state === "ready" ? items.value : [null, null]).map((item, i) => (
            <li key={item?.key ?? i}>
              {item ? (
                <Link to={item.href} className="gl-home__row">
                  <span className={`gl-home__attention-icon gl-home__attention-icon--${item.tone}`} aria-hidden="true">
                    {ATTENTION_ICONS[item.tone]}
                  </span>
                  <span className="gl-home__row-text">
                    <span className="gl-home__row-title">{item.title}</span>
                    <span className="gl-home__row-detail">{item.detail}</span>
                  </span>
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
  )
}

function ActivitySection({ userId }: { userId?: number }) {
  const [feed, setFeed] = useState<Loadable<{ events: ActivityEvent[]; next: number | null }>>({ state: "loading" })
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<unknown>(null)

  useEffect(() => {
    let live = true
    setFeed({ state: "loading" })
    getActivity({ limit: ACTIVITY_PAGE })
      .then((page) => live && setFeed({ state: "ready", value: { events: page.activity, next: page.next_before } }))
      .catch((error) => live && setFeed({ state: "error", error }))
    return () => {
      live = false
    }
  }, [userId])

  const showMore = () => {
    if (feed.state !== "ready" || feed.value.next === null) return
    const { events, next } = feed.value
    setLoadingMore(true)
    setMoreError(null)
    getActivity({ limit: ACTIVITY_PAGE, before: next })
      .then((page) => setFeed({ state: "ready", value: { events: [...events, ...page.activity], next: page.next_before } }))
      .catch((error) => setMoreError(error))
      .finally(() => setLoadingMore(false))
  }

  return (
    <section className="gl-home__section" aria-labelledby="home-activity" aria-busy={feed.state === "loading" || undefined}>
      <h2 id="home-activity">Activity</h2>
      {feed.state === "error" ? (
        <EmptyState compact variant="error" icon="close" title="Couldn't load the activity" description={errorMessage(feed.error)} />
      ) : feed.state === "ready" && feed.value.events.length === 0 ? (
        <EmptyState compact icon={<DocumentIcon size={24} />} title="No activity yet" description="Posts created, published or scheduled, uploads and invitations show up here." />
      ) : (
        <>
          <ol className="gl-home__activity">
            {(feed.state === "ready" ? feed.value.events : [null, null, null]).map((event, i) => (
              <ActivityRow key={event?.id ?? i} event={event} userId={userId} />
            ))}
          </ol>
          {feed.state === "ready" && feed.value.next !== null && (
            <div className="gl-home__activity-more">
              <Button variant="ghost" size="sm" loading={loadingMore} onClick={showMore}>
                Show more
              </Button>
              {moreError ? <span className="gl-home__row-detail" role="alert">{errorMessage(moreError)}</span> : null}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function ActivityRow({ event, userId }: { event: ActivityEvent | null; userId?: number }) {
  if (!event) {
    return (
      <li className="gl-home__event" aria-hidden="true">
        <Skeleton shape="circle" width={24} height={24} />
        <span className="gl-home__event-text">
          <Skeleton shape="text" width="70%" />
        </span>
      </li>
    )
  }
  const line = describeActivity(event, userId)
  return (
    <li className="gl-home__event">
      {line.actorId !== null ? (
        <Avatar user={{ id: line.actorId, name: line.who }} size={24} decorative />
      ) : (
        <span className="gl-home__event-system" aria-hidden="true" />
      )}
      <span className="gl-home__event-text">
        <span>
          <strong>{line.who}</strong> <span className="gl-home__event-verb">{line.verb}</span>{" "}
          {line.what && (line.href ? <Link to={line.href}>{line.what}</Link> : line.what)}
        </span>
        <time className="gl-home__row-detail" dateTime={event.created_at} title={formatFullDate(event.created_at)}>
          {line.when}
        </time>
      </span>
    </li>
  )
}

// value: undefined while loading, null when it couldn't be loaded.
function Count({ label, value, to }: { label: string; value: number | null | undefined; to: string }) {
  return (
    <div className="gl-home__count">
      <dt>
        <Link to={to}>{label}</Link>
      </dt>
      <dd>
        {value === undefined ? (
          <Skeleton width={32} height={24} />
        ) : value === null ? (
          <>
            <span aria-hidden="true">–</span>
            <span className="gl-home__sr">Unavailable</span>
          </>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}
