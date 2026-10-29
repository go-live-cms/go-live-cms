import type { ReactNode } from "react"
import Button from "@gl-admin/components/ui/Button"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import Menu, { MenuItem } from "@gl-admin/components/ui/Menu"
import { CheckIcon, LockIcon, PencilIcon, SortIcon } from "@gl-admin/components/ui/icons"
import PostActions from "@gl-admin/components/content/PostActions"
import { SORT_OPTIONS, findSort, postAccess, rowActions } from "@gl-admin/lib/contentList"
import { isContentModerator, type PermissionUser } from "@gl-admin/lib/roles"
import type { Post } from "@gl-admin/lib/api/types"

// Pieces of the Posts and Pages lists (#340): the page header, the contributor's
// "Your access" cell, the sort menu and the row actions.

export function ListHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <header className="gl-content-list__header">
      <h1>{title}</h1>
      {actions && <div className="gl-content-list__header-actions">{actions}</div>}
    </header>
  )
}

export function AccessCell({ post, user }: { post: Post | null; user: PermissionUser | null | undefined }) {
  if (!post) return <Skeleton shape="text" width={160} />
  const access = postAccess(user, post)
  if (access.canEdit) {
    return (
      <span className="gl-access gl-access--edit">
        <PencilIcon size={14} />
        Can edit · {access.note}
      </span>
    )
  }
  return (
    <span className="gl-access gl-access--view">
      <span className="gl-access__line">
        <LockIcon size={14} />
        View only
      </span>
      {access.note && <span className="gl-access__why">{access.note}</span>}
    </span>
  )
}

// One sort at a time, Last edited by default (#89).
export function SortMenu({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const current = findSort(value)
  return (
    <Menu
      label="Sort by"
      placement="bottom-end"
      trigger={(props) => (
        <Button {...props} variant="ghost" icon={<SortIcon />} aria-label={`Sort by: ${current.label}`}>
          {current.label}
        </Button>
      )}
    >
      {SORT_OPTIONS.map((o) => (
        <MenuItem key={o.id} icon={o.id === current.id ? <CheckIcon /> : <span />} onSelect={() => onChange(o.id)}>
          {o.label}
        </MenuItem>
      ))}
    </Menu>
  )
}

type RowActionsCellProps = {
  post: Post
  user: PermissionUser | null | undefined
  onOpen: (post: Post) => void
  onChanged: () => void
  noun: string
}

// The last column. Contributors see Edit (their own) or Open (view-only) as a button,
// as in the design, plus the menu when they may delete; moderators get the menu.
export function RowActionsCell({ post, user, onOpen, onChanged, noun }: RowActionsCellProps) {
  const moderator = isContentModerator(user?.role)
  const actions = rowActions(user, post)
  const editLabel = postAccess(user, post).canEdit ? "Edit" : "Open"
  return (
    <div className="gl-content-list__actions">
      {!moderator && (
        <Button size="sm" variant="secondary" aria-label={`${editLabel} ${post.title}`} onClick={() => onOpen(post)}>
          {editLabel}
        </Button>
      )}
      {(moderator || actions.length > 0) && (
        <PostActions post={post} actions={actions} editLabel={editLabel} onEdit={() => onOpen(post)} onChanged={onChanged} noun={noun} />
      )}
    </div>
  )
}
