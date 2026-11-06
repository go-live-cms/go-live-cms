import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react"
import Avatar from "@gl-admin/components/ui/Avatar"
import Button, { IconButton } from "@gl-admin/components/ui/Button"
import Menu, { MenuItem } from "@gl-admin/components/ui/Menu"
import Notice from "@gl-admin/components/ui/Notice"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import Tabs from "@gl-admin/components/ui/Tabs"
import Textarea from "@gl-admin/components/ui/Textarea"
import { CloseIcon, MoreIcon } from "@gl-admin/components/ui/icons"
import type { BlockComment, CommentThread, CommentPerson } from "@gl-admin/lib/api/comments"
import {
  blockIdSelector,
  blockLabel,
  COMMENT_BODY_MAX,
  commentBodyError,
  commentErrorMessage,
  filterThreads,
  groupThreads,
  isOpen,
  type CommentBlock,
} from "@gl-admin/lib/comments"
import type { PostCommentsStore } from "@gl-admin/lib/commentsStore"
import { formatLastEdited } from "@gl-admin/lib/contentList"
import "@gl-admin/assets/styles/components/editor/post-settings.scss"
import "@gl-admin/assets/styles/components/editor/comments.scss"

// The comments panel (#192). The redesign canvas draws only the entry points (the top
// bar's Comments button, the block menu's Comment, Home's "commented on"), not the
// panel, so it's built from the settings panel's shell and the #338 components (Tabs,
// Textarea, Menu, Avatar, Notice).
//
// Open · Resolved. Threads are grouped by block in document order; the block's text names
// the group and scrolls the editor to it. Threads whose block the editor can't show
// (#213) are "On hidden blocks"; those whose block is gone are "On deleted blocks": kept,
// and back on their block if a restore brings it back. Everything comes from the store
// (lib/commentsStore.ts); every write's answer replaces what's shown.

type Filter = "open" | "resolved"

interface Props {
  store: PostCommentsStore
  isVisible: boolean
  onClose: () => void
  sidebarWidth: string
}

const personName = (person: CommentPerson | null) => (person ? person.full_name || person.username : "Removed member")

function scrollToBlock(blockId: string) {
  const el = document.querySelector<HTMLElement>(`.gl-content-editor ${blockIdSelector(blockId)}`)
  el?.scrollIntoView?.({ block: "center", behavior: "smooth" })
}

export default function CommentsPanel({ store, isVisible, onClose, sidebarWidth }: Props) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [filter, setFilter] = useState<Filter>("open")
  const [composeFor, setComposeFor] = useState<string | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { data, error, loading, blocks, blocksKnown, hiddenIds, focus } = snapshot

  // Before the editor has bound, nobody knows which blocks exist: list the threads without
  // placing them, rather than calling every one an orphan.
  const groups = useMemo(
    () => (blocksKnown ? groupThreads(data?.threads ?? [], blocks, hiddenIds) : { anchored: [], hidden: [], orphaned: [] }),
    [data, blocks, blocksKnown, hiddenIds]
  )
  const unplaced = blocksKnown ? [] : (data?.threads ?? []).filter((t) => (filter === "open" ? isOpen(t) : !isOpen(t)))
  const shown = useMemo(() => filterThreads(groups, filter), [groups, filter])
  const openCount = data?.threads.filter(isOpen).length ?? 0
  const resolvedCount = (data?.threads.length ?? 0) - openCount

  // The editor asked for a block: its threads, or a new one.
  useEffect(() => {
    if (!focus) return
    setFilter("open")
    // Showing a block's threads keeps a new comment being written elsewhere.
    if (focus.compose) setComposeFor(focus.blockId)
    // After the render that shows it.
    const timer = setTimeout(() => {
      const group = contentRef.current?.querySelector<HTMLElement>(`[data-comment-block="${focus.blockId.replace(/["\\]/g, "\\$&")}"]`)
      group?.scrollIntoView?.({ block: "nearest" })
      if (!focus.compose) group?.querySelector<HTMLElement>("button, textarea")?.focus()
    }, 0)
    return () => clearTimeout(timer)
  }, [focus])

  const composeBlock: CommentBlock | null = composeFor ? (blocks.find((b) => b.id === composeFor) ?? null) : null
  const canComment = !!data?.can_comment

  return (
    <aside
      aria-label="Comments"
      className={`post-settings post-comments ${isVisible ? "post-settings--visible" : ""}`}
      style={{ "--post-settings-width": sidebarWidth } as CSSProperties}
      hidden={!isVisible}
    >
      <div className="post-settings__header">
        <Tabs
          label="Comments"
          className="post-settings__tabs"
          value={filter}
          onChange={(id) => setFilter(id as Filter)}
          tabs={[
            { id: "open", label: "Open", count: data ? openCount : null },
            { id: "resolved", label: "Resolved", count: data ? resolvedCount : null },
          ]}
        />
        <IconButton size="sm" aria-label="Close comments" icon={<CloseIcon />} onClick={onClose} />
      </div>

      <div className="post-settings__content post-comments__content" ref={contentRef}>
        {error && !data ? (
          <Notice
            tone="danger"
            title="Couldn't load comments"
            actions={
              <Button variant="secondary" size="sm" onClick={() => void store.refresh()}>
                Try again
              </Button>
            }
          >
            Check your connection and try again.
          </Notice>
        ) : loading && !data ? (
          <div className="post-comments__loading" aria-busy="true">
            <Skeleton width="60%" />
            <Skeleton width="90%" />
            <Skeleton width="75%" />
          </div>
        ) : (
          <>
            {composeFor && canComment && (
              <section className="post-comments__group" data-comment-block={composeFor} aria-label="New comment">
                <BlockHeading block={composeBlock} blockId={composeFor} onShow={scrollToBlock} />
                <Composer
                  label="New comment"
                  submitLabel="Comment"
                  autoFocus
                  onCancel={() => setComposeFor(null)}
                  onSubmit={async (body) => {
                    await store.startThread(composeFor, body)
                    setComposeFor(null)
                  }}
                />
              </section>
            )}

            {shown.anchored.map(({ block, threads }) => (
              <section
                key={block.id}
                className={`post-comments__group${snapshot.activeBlockId === block.id ? " is-active" : ""}`}
                data-comment-block={block.id}
                onMouseEnter={() => store.setActiveBlock(block.id)}
                onMouseLeave={() => store.setActiveBlock(null)}
              >
                {composeFor !== block.id && <BlockHeading block={block} blockId={block.id} onShow={scrollToBlock} />}
                {threads.map((thread) => (
                  <Thread key={thread.id} thread={thread} store={store} canComment={canComment} />
                ))}
              </section>
            ))}

            {unplaced.length > 0 && (
              <section className="post-comments__group" aria-label="Comments">
                <p className="post-comments__hint">They show on their blocks once the post has loaded.</p>
                {unplaced.map((thread) => (
                  <Thread key={thread.id} thread={thread} store={store} canComment={canComment} />
                ))}
              </section>
            )}

            {shown.hidden.length > 0 && (
              <section className="post-comments__group post-comments__group--detached" aria-label="On hidden blocks">
                <h3 className="post-comments__section-title">On hidden blocks</h3>
                <p className="post-comments__hint">The editor can't show these blocks, but they're kept in the post.</p>
                {shown.hidden.map((thread) => (
                  <Thread key={thread.id} thread={thread} store={store} canComment={canComment} />
                ))}
              </section>
            )}

            {shown.orphaned.length > 0 && (
              <section className="post-comments__group post-comments__group--detached" aria-label="On deleted blocks">
                <h3 className="post-comments__section-title">On deleted blocks</h3>
                <p className="post-comments__hint">
                  Their blocks were deleted or replaced. If a restore brings a block back, its comments go back on it.
                </p>
                {shown.orphaned.map((thread) => (
                  <Thread key={thread.id} thread={thread} store={store} canComment={canComment} />
                ))}
              </section>
            )}

            {!composeFor && unplaced.length === 0 && shown.anchored.length === 0 && shown.hidden.length === 0 && shown.orphaned.length === 0 && (
              <div className="post-comments__empty">
                <p className="post-comments__empty-title">{filter === "open" ? "No open comments" : "No resolved comments"}</p>
                {filter === "open" && canComment && (
                  <p className="post-comments__hint">Point at a block and choose Comment, or press Ctrl M in it.</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  )
}

function BlockHeading({ block, blockId, onShow }: { block: CommentBlock | null; blockId: string; onShow: (id: string) => void }) {
  return (
    <button type="button" className="post-comments__block" onClick={() => onShow(blockId)} title="Show in the post">
      {block ? blockLabel(block) : "Block"}
    </button>
  )
}

function Thread({ thread, store, canComment }: { thread: CommentThread; store: PostCommentsStore; canComment: boolean }) {
  const [replying, setReplying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resolved = !isOpen(thread)

  const toggleResolved = async () => {
    setBusy(true)
    setError(null)
    try {
      await store.setResolved(thread.id, !resolved)
    } catch (e) {
      setError(commentErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className={`post-comments__thread${resolved ? " is-resolved" : ""}`} aria-label={`Comment thread by ${personName(thread.created_by)}`}>
      <ol className="post-comments__list">
        {thread.comments.map((comment) => (
          <Comment key={comment.id} comment={comment} store={store} />
        ))}
      </ol>
      {resolved && (
        <p className="post-comments__resolved">
          Resolved{thread.resolved_by ? ` by ${personName(thread.resolved_by)}` : ""} · {formatLastEdited(thread.resolved_at!)}
        </p>
      )}
      {error && (
        <p className="post-comments__error" role="alert">
          {error}
        </p>
      )}
      {replying ? (
        <Composer
          label="Reply"
          submitLabel="Reply"
          autoFocus
          onCancel={() => setReplying(false)}
          onSubmit={async (body) => {
            await store.reply(thread.id, body)
            setReplying(false)
          }}
        />
      ) : (
        <div className="post-comments__actions">
          {canComment && !resolved && (
            <Button variant="ghost" size="sm" onClick={() => setReplying(true)}>
              Reply
            </Button>
          )}
          {thread.can_resolve && (
            <Button variant="ghost" size="sm" loading={busy} onClick={toggleResolved}>
              {resolved ? "Reopen" : "Resolve"}
            </Button>
          )}
        </div>
      )}
    </article>
  )
}

function Comment({ comment, store }: { comment: BlockComment; store: PostCommentsStore }) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = personName(comment.author)

  if (comment.deleted) {
    return (
      <li className="post-comments__comment post-comments__comment--deleted">
        <span className="post-comments__deleted">Comment deleted</span>
      </li>
    )
  }

  const remove = async () => {
    setError(null)
    try {
      await store.remove(comment.id)
    } catch (e) {
      setError(commentErrorMessage(e))
    }
  }

  return (
    <li className="post-comments__comment">
      <div className="post-comments__meta">
        <Avatar user={{ id: comment.author?.id ?? 0, name, src: comment.author?.avatar }} size={24} decorative />
        <span className="post-comments__name">{name}</span>
        <time className="post-comments__time" dateTime={comment.created_at} title={new Date(comment.created_at).toLocaleString()}>
          {formatLastEdited(comment.created_at)}
        </time>
        {comment.edited_at && <span className="post-comments__edited">(edited)</span>}
        {(comment.can_edit || comment.can_delete) && !editing && (
          <span className="post-comments__menu">
            <Menu
              label="Comment actions"
              placement="bottom-end"
              trigger={(props) => <IconButton {...props} size="sm" aria-label={`Actions for ${name}'s comment`} icon={<MoreIcon />} />}
            >
              {comment.can_edit && <MenuItem onSelect={() => setEditing(true)}>Edit</MenuItem>}
              {comment.can_delete && (
                <MenuItem danger onSelect={() => void remove()}>
                  Delete
                </MenuItem>
              )}
            </Menu>
          </span>
        )}
      </div>
      {editing ? (
        <Composer
          label="Edit comment"
          submitLabel="Save"
          initial={comment.body}
          autoFocus
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            await store.edit(comment.id, body)
            setEditing(false)
          }}
        />
      ) : (
        <p className="post-comments__body">{comment.body}</p>
      )}
      {error && (
        <p className="post-comments__error" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}

function Composer({
  label,
  submitLabel,
  initial = "",
  autoFocus,
  onCancel,
  onSubmit,
}: {
  label: string
  submitLabel: string
  initial?: string
  autoFocus?: boolean
  onCancel: () => void
  onSubmit: (body: string) => Promise<void>
}) {
  const [body, setBody] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const problem = commentBodyError(body)
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(body.trim())
    } catch (e) {
      setError(commentErrorMessage(e))
      setBusy(false)
    }
  }

  return (
    <form
      className="post-comments__composer"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Textarea
        label={label}
        value={body}
        rows={3}
        maxCount={COMMENT_BODY_MAX}
        autoFocus={autoFocus}
        error={error ?? undefined}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void submit()
          }
          if (e.key === "Escape") {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      <div className="post-comments__composer-actions">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" type="submit" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}
