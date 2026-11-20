import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import {
  announceDiscussionChanged,
  bulkModerateComments,
  deleteCommentPermanently,
  editMemberComment,
  findCommenter,
  getDiscussionComments,
  getDiscussionThread,
  moderateComment,
  postMemberComment,
  type DiscussionPage,
  type DiscussionThread,
  type ModerationComment,
  type ReaderCommentBulkAction,
} from "@gl-admin/lib/api/discussion"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import {
  ACTION_LABELS,
  BADGE_LABELS,
  DISCUSSION_TABS,
  actionDoneMessage,
  bulkActionsFor,
  bulkReport,
  canReplyTo,
  commentLabel,
  commenterCounts,
  commenterLine,
  deleteConfirm,
  discussionLine,
  emptyQueue,
  excerpt,
  findDiscussionTab,
  firstName,
  isOwnComment,
  networkLine,
  phoneActions,
  postNotPublished,
  reasonLabel,
  replyButton,
  replyFailure,
  replyHint,
  replyLabel,
  replyPosted,
  rowActions,
  selectionAfterBulk,
  threadPill,
  trashLines,
  type DiscussionBulkReport,
  type RowAction,
} from "@gl-admin/lib/discussion"
import { formatLastEdited } from "@gl-admin/lib/contentList"
import { isSiteAdmin } from "@gl-admin/lib/roles"
import { useAuthUser } from "@gl-admin/lib/hooks/useAuthUser"
import { useListParams } from "@gl-admin/lib/hooks/useListParams"
import { useMediaQuery } from "@gl-admin/lib/hooks/useMediaQuery"
import { usePageTitle } from "@gl-admin/lib/hooks/usePageTitle"
import { MOBILE_QUERY } from "@gl-admin/components/sidebar/Sidebar"
import { ListHeader } from "@gl-admin/components/content/ListParts"
import Tabs from "@gl-admin/components/ui/Tabs"
import Button, { IconButton, buttonClassName } from "@gl-admin/components/ui/Button"
import Checkbox from "@gl-admin/components/ui/Checkbox"
import Drawer from "@gl-admin/components/ui/Drawer"
import Modal from "@gl-admin/components/ui/Modal"
import Notice from "@gl-admin/components/ui/Notice"
import Pill from "@gl-admin/components/ui/Pill"
import Avatar from "@gl-admin/components/ui/Avatar"
import Input from "@gl-admin/components/ui/Input"
import Textarea from "@gl-admin/components/ui/Textarea"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import Menu, { MenuItem } from "@gl-admin/components/ui/Menu"
import { toast } from "@gl-admin/components/ui/Toast"
import { CheckIcon, CloseIcon, MoreIcon, PlusIcon, SearchIcon } from "@gl-admin/components/ui/icons"
import "@gl-admin/assets/styles/pages/discussion.scss"

// Discussion (#526; design docs/design/reader-comments.md 4.4, the #521 boards "Discussion
// · queue", "comment drawer" and "375 · Discussion"): reader comments, moderated by
// editors and admins (contributors have no entry and the route answers the 403 page).
// Opens on Pending, newest first; Approved, Spam and Trash tabs with counts that follow
// the filters (post, commenter, text search). Rows are selectable, with the tab's bulk
// actions answering per comment as the posts list does. A comment opens a drawer with
// its whole thread, a reply box ("Approve and reply" under a pending one) and the
// commenter's summary. At phone width each row keeps Approve and Spam as 44px buttons,
// Trash behind More, and the drawer has no reply box. The view lives in the URL
// (?status=&post=&commenter=&q=&page=&comment=). Rules and wording: lib/discussion.ts.

const PAGE_SIZE = 25

const avatarUser = (c: ModerationComment) => ({
  id: c.commenter?.id ?? c.author_user_id ?? c.id,
  name: c.name || "?",
  src: c.avatar,
})

function when(iso: string) {
  return formatLastEdited(iso)
}

export default function Discussion() {
  usePageTitle("Discussion")
  const navigate = useNavigate()
  const user = useAuthUser()
  const me = user?.full_name || user?.username || "you"
  const admin = isSiteAdmin(user?.role)
  const isPhone = useMediaQuery(MOBILE_QUERY)
  const [params, setParam] = useListParams()
  const [, setSearchParams] = useSearchParams()
  const tab = findDiscussionTab(params.get("status"))
  const postId = Number(params.get("post")) || null
  const commenterId = Number(params.get("commenter")) || null
  const search = params.get("q")?.trim() ?? ""
  const page = Math.max(1, Number(params.get("page")) || 1)
  const openId = Number(params.get("comment")) || null

  const [data, setData] = useState<DiscussionPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<DiscussionBulkReport | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number[] | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  // Names of the filters' post and commenter, kept from the rows that had them.
  const [filterNames, setFilterNames] = useState<{ post?: string; commenter?: string }>({})

  const reload = useCallback(() => setRefresh((n) => n + 1), [])

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    getDiscussionComments(tab.id, { post_id: postId, commenter_id: commenterId, q: search }, page, PAGE_SIZE)
      .then((answer) => {
        if (!live) return
        setData(answer)
        const first = answer.comments[0]
        if (first) {
          setFilterNames((names) => ({
            post: postId && first.post.id === postId ? first.post.title || "Untitled" : names.post,
            commenter: commenterId && first.commenter?.id === commenterId ? first.name : names.commenter,
          }))
        }
      })
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [tab.id, postId, commenterId, search, page, refresh])

  // Another view starts with nothing selected.
  useEffect(() => {
    setSelected([])
    setReport(null)
  }, [tab.id, postId, commenterId, search, page])

  // The search box; the URL follows it after a pause (the posts list's pattern).
  const [searchText, setSearchText] = useState(search)
  const latest = useRef(params)
  latest.current = params
  useEffect(() => {
    if (searchText.trim() === search) return
    const id = setTimeout(() => {
      const next = new URLSearchParams(latest.current)
      if (searchText.trim()) next.set("q", searchText.trim())
      else next.delete("q")
      next.delete("page")
      setSearchParams(next, { replace: true })
    }, 400)
    return () => clearTimeout(id)
  }, [searchText])
  useEffect(() => {
    setSearchText((text) => (text.trim() === search ? text : search))
  }, [search])

  const setParams = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") next.delete(k)
      else next.set(k, v)
    }
    setSearchParams(next, { replace: true })
  }
  const openThread = (id: number) => setParams({ comment: String(id) })
  const closeThread = () => setParams({ comment: null })

  const changed = () => {
    reload()
    announceDiscussionChanged()
  }

  const comments = data?.comments ?? []
  const counts = data?.counts
  const pageIds = comments.map((c) => c.id)
  const names = useMemo(() => new Map(comments.map((c) => [c.id, c.name || "A comment"])), [comments])

  const runAction = async (comment: ModerationComment, action: RowAction) => {
    if (action === "reply" || action === "edit") return openThread(comment.id)
    if (action === "delete") return setConfirmDelete([comment.id])
    try {
      await moderateComment(comment.id, action)
      toast.success(actionDoneMessage(action))
      changed()
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't change the comment"))
      reload()
    }
  }

  const runBulk = async (action: ReaderCommentBulkAction, ids: number[]) => {
    if (ids.length === 0) return
    setBusy(true)
    try {
      if (ids.length === 1 && action === "delete" && !selected.includes(ids[0])) {
        await deleteCommentPermanently(ids[0])
        toast.success(actionDoneMessage("delete"))
        if (openId === ids[0]) closeThread()
      } else {
        const answer = await bulkModerateComments(action, ids)
        const r = bulkReport(action, answer.results, names)
        setReport(r.partial ? r : null)
        if (!r.partial) toast.success(r.message)
        setSelected(selectionAfterBulk(answer.results))
      }
      setConfirmDelete(null)
      changed()
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't change the selected comments"))
    } finally {
      setBusy(false)
    }
  }
  const onBulk = (action: ReaderCommentBulkAction) => (action === "delete" ? setConfirmDelete([...selected]) : void runBulk(action, [...selected]))

  const filtered = !!(postId || commenterId || search)
  const toggle = (id: number, on: boolean) => setSelected((s) => (on ? [...new Set([...s, id])] : s.filter((x) => x !== id)))
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.includes(id))
  const someSelected = !allSelected && pageIds.some((id) => selected.includes(id))
  const totalAll = counts ? counts.pending + counts.approved + counts.spam + counts.trash : 0
  const off = data && !data.comments_enabled
  const totalPages = data?.pagination.total_pages ?? 1

  // The filters' options are the posts and commenters on this page.
  const postOptions = useMemo(() => uniqueBy(comments, (c) => c.post.id).map((c) => ({ id: c.post.id, label: c.post.title || "Untitled" })), [comments])
  const commenterOptions = useMemo(
    () => uniqueBy(comments.filter((c) => c.commenter), (c) => c.commenter!.id).map((c) => ({ id: c.commenter!.id, label: c.name })),
    [comments]
  )

  return (
    <section className="gl-content-list gl-discussion">
      <ListHeader
        title="Discussion"
        actions={
          <Button variant="secondary" onClick={() => setFindOpen(true)}>
            Find a commenter
          </Button>
        }
      />
      <p className="gl-discussion__sub">Comments readers left on published posts.</p>

      {off && totalAll > 0 && (
        <Notice tone="info" title="Comments are off for this site">
          Readers see no comments section and can't write any. These are kept and come back when comments are turned on.
          {admin && (
            <>
              {" "}
              <Link to="/settings/discussion">Open Settings › Discussion</Link>
            </>
          )}
        </Notice>
      )}

      {off && totalAll === 0 && !loading ? (
        <EmptyState
          title="Comments are off for this site"
          description={
            admin
              ? "Readers see no comments section and can't write any. Comments you already have are kept and come back when you turn them on."
              : "An admin can turn them on in Settings › Discussion."
          }
          action={
            admin && (
              <Button variant="primary" onClick={() => navigate("/settings/discussion")}>
                Open Settings › Discussion
              </Button>
            )
          }
        />
      ) : (
        <>
          <Tabs
            label="Status"
            activation="manual"
            tabs={DISCUSSION_TABS.map((t) => ({ id: t.id, label: t.label, count: counts ? counts[t.id] : undefined }))}
            value={tab.id}
            onChange={(id) => setParams({ status: id === "pending" ? null : id, page: null })}
          />

          <div className="gl-content-list__toolbar gl-discussion__tools">
            <label className="gl-content-list__search">
              <SearchIcon />
              <span className="gl-content-list__sr">Search comments</span>
              <input
                type="search"
                placeholder="Search comments"
                value={searchText}
                maxLength={200}
                onChange={(e) => setSearchText(e.currentTarget.value)}
              />
            </label>
            <div className="gl-content-list__filters" role="group" aria-label="Filters">
              <FilterChip
                label="Post"
                value={postId ? filterNames.post || `Post ${postId}` : null}
                options={postOptions}
                onPick={(id) => setParams({ post: String(id), page: null })}
                onClear={() => setParams({ post: null, page: null })}
              />
              <FilterChip
                label="Commenter"
                value={commenterId ? filterNames.commenter || "This commenter" : null}
                options={commenterOptions}
                onPick={(id) => setParams({ commenter: String(id), page: null })}
                onClear={() => setParams({ commenter: null, page: null })}
              />
            </div>
            <span className="gl-content-list__sorted">Newest first</span>
          </div>

          {report && (
            <Notice tone="warning" live="status" title={report.message} onDismiss={() => setReport(null)}>
              <ul className="gl-bulk-report__failures">
                {report.failures.map((f) => (
                  <li key={f.id}>
                    <span className="gl-bulk-report__title">{f.name}</span>: {f.reason}
                  </li>
                ))}
              </ul>
            </Notice>
          )}

          {selected.length > 0 && (
            <div role="region" aria-label="Bulk actions" className="gl-bulk-bar">
              <span className="gl-bulk-bar__count" aria-live="polite">
                {selected.length} selected
              </span>
              <div className="gl-bulk-bar__actions">
                {bulkActionsFor(tab.id).map((a) => (
                  <Button key={a} size="sm" variant={a === "delete" ? "danger" : "secondary"} disabled={busy} onClick={() => onBulk(a)}>
                    {ACTION_LABELS[a]}
                  </Button>
                ))}
              </div>
              <IconButton size="sm" variant="ghost" aria-label="Clear selection" icon={<CloseIcon />} onClick={() => setSelected([])} disabled={busy} />
            </div>
          )}

          {error ? (
            <EmptyState
              variant="error"
              icon="close"
              title="Comments didn't load"
              description={`Nothing was changed. ${errorMessage(error, "Try again in a moment.")}`}
              action={
                <Button variant="primary" onClick={reload}>
                  Try again
                </Button>
              }
            />
          ) : loading && !data ? (
            <QueueSkeleton />
          ) : comments.length === 0 ? (
            <EmptyState compact title={emptyQueue(tab.id, filtered).title} description={emptyQueue(tab.id, filtered).description} />
          ) : (
            <>
              {loading && (
                <span role="status" className="gl-content-list__sr">
                  Loading comments…
                </span>
              )}
              <ul className="gl-dq-list" aria-label={`${tab.label} comments`} aria-busy={loading || undefined}>
                <li className="gl-dq-row gl-dq-row--all">
                  <Checkbox
                    aria-label="Select all on this page"
                    checked={allSelected}
                    indeterminate={someSelected}
                    onChange={(on) => setSelected(on ? pageIds : [])}
                  />
                  <span className="gl-dq-row__all-label" aria-hidden="true">
                    Select all {pageIds.length} on this page
                  </span>
                </li>
                {comments.map((c) => (
                  <QueueRow
                    key={c.id}
                    comment={c}
                    meId={user?.id}
                    selected={selected.includes(c.id)}
                    onSelect={(on) => toggle(c.id, on)}
                    expanded={expanded.has(c.id)}
                    onExpand={() => setExpanded((s) => new Set(s).add(c.id))}
                    onAction={(a) => void runAction(c, a)}
                    onOpen={() => openThread(c.id)}
                  />
                ))}
              </ul>
              {totalPages > 1 && (
                <nav className="gl-discussion__pager" aria-label="Pages">
                  <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setParam("page", String(page - 1), "1")}>
                    Previous
                  </Button>
                  <span>
                    Page {page} of {totalPages}
                  </span>
                  <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setParam("page", String(page + 1), "1")}>
                    Next
                  </Button>
                </nav>
              )}
            </>
          )}
        </>
      )}

      <CommentDrawer
        id={openId}
        me={me}
        meId={user?.id}
        isPhone={isPhone}
        onClose={closeThread}
        onChanged={changed}
        onDelete={(id) => setConfirmDelete([id])}
      />

      <Modal
        isOpen={!!confirmDelete}
        onClose={() => !busy && setConfirmDelete(null)}
        role="alertdialog"
        size="small"
        title={deleteConfirm(confirmDelete?.length ?? 1).title}
        description={deleteConfirm(confirmDelete?.length ?? 1).body}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => confirmDelete && void runBulk("delete", confirmDelete)}>
              {deleteConfirm(confirmDelete?.length ?? 1).button}
            </Button>
          </>
        }
      >
        {null}
      </Modal>

      <FindCommenterDialog isOpen={findOpen} onClose={() => setFindOpen(false)} onFound={(id) => navigate(`/discussion/commenters/${id}`)} />
    </section>
  )
}

function uniqueBy<T>(items: T[], key: (item: T) => number): T[] {
  const seen = new Set<number>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// A filter chip (16.1): "+ Post" picks from the posts on this page; once set it shows the
// value with a button that clears it.
function FilterChip({
  label,
  value,
  options,
  onPick,
  onClear,
}: {
  label: string
  value: string | null
  options: { id: number; label: string }[]
  onPick: (id: number) => void
  onClear: () => void
}) {
  if (value) {
    return (
      <span className="gl-dq-filter is-set">
        <span>
          {label}: {value}
        </span>
        <button type="button" className="gl-dq-filter__clear" aria-label={`Remove the ${label.toLowerCase()} filter`} onClick={onClear}>
          <CloseIcon size={14} />
        </button>
      </span>
    )
  }
  if (options.length === 0) return null
  return (
    <Menu
      label={`Filter by ${label.toLowerCase()}`}
      trigger={(props) => (
        <button {...props} type="button" className="gl-dq-filter">
          <PlusIcon size={14} />
          {label}
        </button>
      )}
    >
      {options.map((o) => (
        <MenuItem key={o.id} onSelect={() => onPick(o.id)}>
          {o.label}
        </MenuItem>
      ))}
    </Menu>
  )
}

function QueueSkeleton() {
  return (
    <>
      <span role="status" className="gl-content-list__sr">
        Loading comments…
      </span>
      <ul className="gl-dq-list" aria-hidden="true">
        {["72%", "58%", "66%"].map((w) => (
          <li key={w} className="gl-dq-row">
            <Skeleton width={16} height={16} />
            <Skeleton shape="circle" width={28} height={28} />
            <div className="gl-dq-row__body">
              <Skeleton shape="text" width={180} />
              <Skeleton shape="text" width={w} />
              <Skeleton shape="text" width="40%" />
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}

type QueueRowProps = {
  comment: ModerationComment
  meId: number | null | undefined
  selected: boolean
  onSelect: (on: boolean) => void
  expanded: boolean
  onExpand: () => void
  onAction: (action: RowAction) => void
  onOpen: () => void
}

function QueueRow({ comment: c, meId, selected, onSelect, expanded, onExpand, onAction, onOpen }: QueueRowProps) {
  const reason = reasonLabel(c)
  const text = excerpt(c.body, expanded)
  const actions = rowActions(c, meId)
  const phone = phoneActions(c)
  const who = c.name || "Someone"
  const label = (a: RowAction) => `${ACTION_LABELS[a]} ${who}'s comment`
  return (
    <li className={`gl-dq-row${selected ? " is-selected" : ""}`}>
      <Checkbox aria-label={`Select comment by ${who}`} checked={selected} onChange={onSelect} />
      <Avatar user={avatarUser(c)} size={28} decorative />
      <div className="gl-dq-row__body">
        <div className="gl-dq-who">
          <b>{who}</b>
          {c.badge && <span className="gl-dq-badge">{BADGE_LABELS[c.badge]}</span>}
          {c.commenter && <span className="gl-dq-mail">{c.commenter.email}</span>}
          {!c.commenter && c.badge && <span className="gl-dq-mail">Member</span>}
          {c.commenter?.new && <span className="gl-dq-tag">New commenter</span>}
          {c.commenter?.blocked && <span className="gl-dq-tag">Blocked</span>}
          {reason && (
            <Pill tone={c.status === "spam" ? "danger" : "warning"} dot={false}>
              {reason}
            </Pill>
          )}
          {c.status === "trash" && c.trashed_from && <span className="gl-dq-tag">Was {c.trashed_from}</span>}
        </div>
        <p className="gl-dq-text">
          {text.text}
          {text.truncated && (
            <>
              {" "}
              <button type="button" className="gl-dq-more" onClick={onExpand} aria-label={`Show all of ${who}'s comment`}>
                Show more
              </button>
            </>
          )}
        </p>
        <div className="gl-dq-meta">
          <span>
            On{" "}
            <a href={c.post.url} target="_blank" rel="noopener noreferrer">
              {c.post.title || "Untitled"}
            </a>
          </span>
          {postNotPublished(c) && (
            <Pill tone="neutral" dot={false}>
              Post not published
            </Pill>
          )}
          {c.replying_to && <span>Reply to {c.replying_to}</span>}
          <Link to={`/content/edit/${c.post.id}`}>Open post in editor</Link>
          <button type="button" className="gl-dq-link" onClick={onOpen}>
            View thread
          </button>
          <time dateTime={c.created_at}>{when(c.created_at)}</time>
          {c.status === "trash" &&
            trashLines(c).map((line) => (
              <span key={line}>{line}</span>
            ))}
        </div>
        <div className="gl-dq-acts gl-dq-acts--wide">
          {actions.map((a) => (
            <Button
              key={a}
              size="sm"
              variant={a === "reply" ? "ghost" : a === "delete" ? "danger" : "secondary"}
              icon={a === "approve" ? <CheckIcon size={14} /> : undefined}
              aria-label={label(a)}
              onClick={() => onAction(a)}
            >
              {ACTION_LABELS[a]}
            </Button>
          ))}
        </div>
        <div className="gl-dq-acts gl-dq-acts--phone">
          {phone.primary.map((a) => (
            <Button key={a} variant={a === "delete" ? "danger" : "secondary"} aria-label={label(a)} onClick={() => onAction(a)}>
              {ACTION_LABELS[a]}
            </Button>
          ))}
          <Menu
            label={`More actions for ${who}'s comment`}
            placement="bottom-end"
            trigger={(props) => (
              <button {...props} type="button" className="gl-dq-phone-more" aria-label={`More actions for ${who}'s comment`}>
                <MoreIcon size={16} />
              </button>
            )}
          >
            {phone.more.map((a) => (
              <MenuItem key={a} danger={a === "delete"} onSelect={() => onAction(a)}>
                {ACTION_LABELS[a]}
              </MenuItem>
            ))}
            <MenuItem onSelect={onOpen}>View thread</MenuItem>
          </Menu>
        </div>
      </div>
    </li>
  )
}

type DrawerProps = {
  id: number | null
  me: string
  meId: number | null | undefined
  isPhone: boolean
  onClose: () => void
  onChanged: () => void
  onDelete: (id: number) => void
}

// The comment drawer (4.4, the "comment drawer" board): the whole thread in every status,
// the reply box and the commenter's summary.
function CommentDrawer({ id, me, meId, isPhone, onClose, onChanged, onDelete }: DrawerProps) {
  const [thread, setThread] = useState<DiscussionThread | null>(null)
  const [failed, setFailed] = useState<unknown>(null)
  const [reload, setReload] = useState(0)
  const [reply, setReply] = useState("")
  const [sending, setSending] = useState(false)
  const [replyError, setReplyError] = useState<{ title: string; body: string } | null>(null)
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null)

  useEffect(() => {
    if (!id) {
      setThread(null)
      return
    }
    let live = true
    setFailed(null)
    getDiscussionThread(id)
      .then((t) => live && setThread(t))
      .catch((e) => live && setFailed(e))
    return () => {
      live = false
    }
  }, [id, reload])

  useEffect(() => {
    setReply("")
    setReplyError(null)
    setEditing(null)
  }, [id])

  const comment = thread && thread.comment.id === id ? thread.comment : null
  const refresh = () => {
    setReload((n) => n + 1)
    onChanged()
  }

  const act = async (target: ModerationComment, action: RowAction) => {
    if (action === "delete") return onDelete(target.id)
    if (action === "edit") return setEditing({ id: target.id, text: target.body })
    if (action === "reply") return
    try {
      await moderateComment(target.id, action)
      toast.success(actionDoneMessage(action))
      refresh()
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't change the comment"))
      setReload((n) => n + 1)
    }
  }

  const sendReply = async (e: FormEvent) => {
    e.preventDefault()
    if (!comment || !reply.trim()) return
    setSending(true)
    setReplyError(null)
    try {
      const answer = await postMemberComment(comment.post.id, reply, comment.id)
      setReply("")
      toast.success(replyPosted(answer.parent_approved, comment), {
        action: { label: "View on site", onClick: () => window.open(`${comment.post.url}#comment-${answer.comment.id}`, "_blank", "noopener,noreferrer") },
      })
      refresh()
    } catch (err) {
      setReplyError(replyFailure(err instanceof ApiError ? err.code : null))
    } finally {
      setSending(false)
    }
  }

  const saveEdit = async () => {
    if (!editing) return
    try {
      await editMemberComment(editing.id, editing.text)
      setEditing(null)
      toast.success("Comment saved.")
      refresh()
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't save the comment"))
    }
  }

  const title = comment ? comment.post.title || "Untitled" : "Comment"
  const replyId = useMemo(() => `gl-dq-reply-${id ?? 0}`, [id])

  return (
    <Drawer isOpen={!!id} onClose={onClose} title={title} width={560} className="gl-dq-drawer">
      {failed ? (
        <Notice tone="danger" title="This thread didn't load">
          The queue is fine.{" "}
          <Button variant="ghost" size="sm" onClick={() => setReload((n) => n + 1)}>
            Try again
          </Button>
        </Notice>
      ) : !comment ? (
        <div className="gl-dq-drawer__loading" aria-hidden="true">
          <Skeleton shape="text" width={160} />
          <Skeleton shape="text" width="80%" />
          <Skeleton shape="text" width={140} />
        </div>
      ) : (
        <div className="gl-dq-drawer__body">
          <p className="gl-dq-meta">
            <span>Comment on this post</span>
            <a href={comment.post.url} target="_blank" rel="noopener noreferrer">
              View on site
            </a>
            <Link to={`/content/edit/${comment.post.id}`}>Open in editor</Link>
            {discussionLine(thread!.discussion) && <span>{discussionLine(thread!.discussion)}</span>}
          </p>

          <ThreadList
            thread={thread!.thread}
            openId={comment.id}
            meId={meId}
            editing={editing}
            onEdit={setEditing}
            onSaveEdit={() => void saveEdit()}
            onAction={(c, a) => void act(c, a)}
            isPhone={isPhone}
          />

          {canReplyTo(comment) &&
            (isPhone ? (
              <p className="gl-dq-help">Replying needs a larger screen.</p>
            ) : (
              <form className="gl-dq-reply" onSubmit={sendReply}>
                <Textarea
                  label={replyLabel(comment, me)}
                  value={reply}
                  onChange={(e) => setReply(e.currentTarget.value)}
                  hint={replyHint(comment)}
                  maxCount={4000}
                  rows={4}
                  id={replyId}
                />
                {replyError && (
                  <Notice tone="danger" live="alert" title={replyError.title}>
                    {replyError.body}
                  </Notice>
                )}
                <div className="gl-dq-reply__actions">
                  <Button variant="ghost" type="button" onClick={() => setReply("")} disabled={sending || !reply}>
                    Cancel
                  </Button>
                  <Button variant="primary" type="submit" loading={sending} disabled={!reply.trim()}>
                    {replyButton(comment)}
                  </Button>
                </div>
              </form>
            ))}

          {thread!.commenter && (
            <section className="gl-dq-sum" aria-labelledby={`gl-dq-sum-${thread!.commenter.id}`}>
              <div className="gl-dq-sum__head">
                <Avatar user={{ id: thread!.commenter.id, name: thread!.commenter.name }} size={28} decorative />
                <div className="gl-dq-sum__who">
                  <b id={`gl-dq-sum-${thread!.commenter.id}`}>{thread!.commenter.name}</b>
                  <span className="gl-dq-mail">{commenterLine(thread!.commenter)}</span>
                </div>
                <Link to={`/discussion/commenters/${thread!.commenter.id}`} className={buttonClassName("secondary", "sm")}>
                  Commenter page
                </Link>
              </div>
              <p className="gl-dq-meta gl-dq-sum__counts">
                {commenterCounts(thread!.commenter).map((line) => (
                  <span key={line}>{line}</span>
                ))}
                {networkLine(thread!.commenter.network_neighbours) && <span>{networkLine(thread!.commenter.network_neighbours)}</span>}
              </p>
            </section>
          )}
        </div>
      )}
    </Drawer>
  )
}

function ThreadList({
  thread,
  openId,
  meId,
  editing,
  onEdit,
  onSaveEdit,
  onAction,
  isPhone,
}: {
  thread: ModerationComment[]
  openId: number
  meId: number | null | undefined
  editing: { id: number; text: string } | null
  onEdit: (e: { id: number; text: string } | null) => void
  onSaveEdit: () => void
  onAction: (c: ModerationComment, a: RowAction) => void
  isPhone: boolean
}) {
  const root = thread.find((c) => c.root_id === null)
  const replies = thread.filter((c) => c.root_id !== null)
  const item = (c: ModerationComment) => (
    <ThreadComment
      comment={c}
      open={c.id === openId}
      meId={meId}
      editing={editing?.id === c.id ? editing : null}
      onEdit={onEdit}
      onSaveEdit={onSaveEdit}
      onAction={(a) => onAction(c, a)}
      isPhone={isPhone}
    />
  )
  return (
    <ol className="gl-dq-thread" aria-label="Thread">
      {root ? (
        <li>
          {item(root)}
          {replies.length > 0 && (
            <ol className="gl-dq-replies">
              {replies.map((c) => (
                <li key={c.id}>{item(c)}</li>
              ))}
            </ol>
          )}
        </li>
      ) : (
        replies.map((c) => <li key={c.id}>{item(c)}</li>)
      )}
    </ol>
  )
}

function ThreadComment({
  comment: c,
  open,
  meId,
  editing,
  onEdit,
  onSaveEdit,
  onAction,
  isPhone,
}: {
  comment: ModerationComment
  open: boolean
  meId: number | null | undefined
  editing: { id: number; text: string } | null
  onEdit: (e: { id: number; text: string } | null) => void
  onSaveEdit: () => void
  onAction: (a: RowAction) => void
  isPhone: boolean
}) {
  if (c.removed) {
    return (
      <article className="gl-dq-c is-removed" aria-label="Removed comment">
        <div className="gl-dq-row__body">
          <b className="gl-dq-removed">This comment was removed</b>
          <span className="gl-dq-meta">Deleted for good: its text, name and commenter are gone. It goes when its last reply does.</span>
        </div>
      </article>
    )
  }
  const pill = threadPill(c)
  const own = isOwnComment(c, meId)
  // The opened comment carries its actions; your own comment its Edit (6.4).
  const actions = open ? rowActions(c, meId).filter((a) => a !== "reply" && (!isPhone || a !== "edit")) : own && !isPhone && c.status === "approved" ? (["edit"] as RowAction[]) : c.status === "trash" ? (["restore"] as RowAction[]) : []
  const who = c.name || "Someone"
  return (
    <article className={`gl-dq-c${open ? " is-open" : ""}${c.status !== "approved" ? " is-held" : ""}`} aria-label={commentLabel(c)}>
      <Avatar user={avatarUser(c)} size={24} decorative />
      <div className="gl-dq-row__body">
        <div className="gl-dq-who">
          <b>{who}</b>
          {c.badge && <span className="gl-dq-badge">{BADGE_LABELS[c.badge]}</span>}
          {!c.badge && !c.commenter && <span className="gl-dq-mail">No longer a member</span>}
          {pill && (
            <Pill tone={pill.tone} dot={false}>
              {pill.label}
            </Pill>
          )}
          <span className="gl-dq-mail">
            <time dateTime={c.created_at}>{when(c.created_at)}</time>
            {c.edited ? " · Edited" : ""}
          </span>
        </div>
        {c.replying_to && c.parent_id !== c.root_id && <span className="gl-dq-meta">Replying to {firstName(c.replying_to)}</span>}
        {editing ? (
          <div className="gl-dq-edit">
            <Textarea label="Edit your comment" value={editing.text} maxCount={4000} rows={3} onChange={(e) => onEdit({ id: c.id, text: e.currentTarget.value })} />
            <div className="gl-dq-reply__actions">
              <Button variant="ghost" size="sm" onClick={() => onEdit(null)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={onSaveEdit} disabled={!editing.text.trim()}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <p className="gl-dq-text">{c.body}</p>
        )}
        {c.status !== "approved" && !open && c.root_id === null && (
          <span className="gl-dq-meta">Readers see “This comment was removed” while it has approved replies.</span>
        )}
        {actions.length > 0 && !editing && (
          <div className={`gl-dq-acts${isPhone ? " gl-dq-acts--big" : ""}`}>
            {actions.map((a) => (
              <Button
                key={a}
                size={isPhone ? "md" : "sm"}
                variant={a === "approve" && isPhone ? "primary" : a === "delete" ? "danger" : "secondary"}
                aria-label={`${ACTION_LABELS[a]} ${who}'s comment`}
                onClick={() => onAction(a)}
              >
                {ACTION_LABELS[a]}
              </Button>
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

// Find a commenter (16.1): the whole address, so the queue can't be fished for emails.
function FindCommenterDialog({ isOpen, onClose, onFound }: { isOpen: boolean; onClose: () => void; onFound: (id: number) => void }) {
  const [email, setEmail] = useState("")
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (isOpen) {
      setEmail("")
      setProblem(null)
    }
  }, [isOpen])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!email.includes("@")) {
      setProblem("Enter the whole address.")
      return
    }
    setBusy(true)
    try {
      const id = await findCommenter(email)
      onClose()
      onFound(id)
    } catch (err) {
      setProblem(err instanceof ApiError && err.status === 404 ? "No commenter uses this address. Check it's the whole address." : errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="small"
      title="Find a commenter"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="gl-dq-find" loading={busy}>
            Find
          </Button>
        </>
      }
    >
      <form id="gl-dq-find" onSubmit={submit} noValidate>
        <Input title="Email address" unmasked value={email} onChange={(e) => setEmail(e.currentTarget.value)} error={problem} autoComplete="off" />
      </form>
    </Modal>
  )
}
