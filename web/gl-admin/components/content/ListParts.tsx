import type { ReactNode } from "react"
import Button, { IconButton } from "@gl-admin/components/ui/Button"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import Notice from "@gl-admin/components/ui/Notice"
import Menu, { MenuItem, MenuSeparator } from "@gl-admin/components/ui/Menu"
import { CheckIcon, ChevronDownIcon, CloseIcon, LockIcon, PencilIcon, SortIcon } from "@gl-admin/components/ui/icons"
import PostActions from "@gl-admin/components/content/PostActions"
import {
  BULK_LABELS,
  SORT_OPTIONS,
  findSort,
  postAccess,
  rowActions,
  type BulkAction,
  type BulkReport,
} from "@gl-admin/lib/contentList"
import { isContentModerator, isTrashed, type PermissionUser } from "@gl-admin/lib/roles"
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

export type FilterOption = { id: string; label: string }

// One list filter (#327): a menu button that reads "Author", or "Author: Ana Costa" once
// one is picked, with "Any author" to clear it.
export function FilterMenu({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: FilterOption[]
  value: string
  onChange: (id: string) => void
}) {
  const current = options.find((o) => o.id === value)
  const noun = label.toLowerCase()
  return (
    <Menu
      label={`Filter by ${noun}`}
      trigger={(props) => (
        <Button
          {...props}
          variant={current ? "secondary" : "ghost"}
          className="gl-content-list__filter"
          aria-label={current ? `${label}: ${current.label}` : `Filter by ${noun}`}
        >
          {current ? `${label}: ${current.label}` : label}
          <ChevronDownIcon size={14} />
        </Button>
      )}
    >
      <MenuItem icon={!current ? <CheckIcon /> : <span />} onSelect={() => onChange("")}>
        Any {noun}
      </MenuItem>
      {options.length > 0 && <MenuSeparator />}
      {options.map((o) => (
        <MenuItem key={o.id} icon={o.id === value ? <CheckIcon /> : <span />} onSelect={() => onChange(o.id)}>
          {o.label}
        </MenuItem>
      ))}
    </Menu>
  )
}

// The bar over the table while rows are selected (#327): "2 selected", the actions the
// tab offers (bulkActions), and Clear selection.
export function BulkBar({
  count,
  actions,
  busy,
  onAction,
  onClear,
}: {
  count: number
  actions: BulkAction[]
  busy: boolean
  onAction: (action: BulkAction) => void
  onClear: () => void
}) {
  return (
    <div role="region" aria-label="Bulk actions" className="gl-bulk-bar">
      <span className="gl-bulk-bar__count" aria-live="polite">
        {count} selected
      </span>
      <div className="gl-bulk-bar__actions">
        {actions.map((a) => (
          <Button key={a} size="sm" variant={a === "delete" ? "danger" : "secondary"} disabled={busy} onClick={() => onAction(a)}>
            {BULK_LABELS[a]}
          </Button>
        ))}
      </div>
      <IconButton size="sm" variant="ghost" aria-label="Clear selection" icon={<CloseIcon />} onClick={onClear} disabled={busy} />
    </div>
  )
}

// What a bulk action did (#327): the posts it changed, then each one it couldn't and why.
export function BulkReportNotice({ report, onDismiss }: { report: BulkReport; onDismiss: () => void }) {
  const partial = report.failures.length > 0
  return (
    <Notice
      tone={partial ? "warning" : "info"}
      live="status"
      className="gl-bulk-report"
      title={[report.done, report.failed].filter(Boolean).join(". ")}
      onDismiss={onDismiss}
    >
      {partial && (
        <ul className="gl-bulk-report__failures">
          {report.failures.map((f) => (
            <li key={f.id}>
              <span className="gl-bulk-report__title">{f.title}</span>: {f.reason}
            </li>
          ))}
        </ul>
      )}
    </Notice>
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
  // A trashed post (#327) opens nowhere: restore it first.
  const trashed = isTrashed(post)
  return (
    <div className="gl-content-list__actions">
      {!moderator && !trashed && (
        <Button size="sm" variant="secondary" aria-label={`${editLabel} ${post.title}`} onClick={() => onOpen(post)}>
          {editLabel}
        </Button>
      )}
      {(moderator ? !trashed || actions.length > 0 : actions.length > 0) && (
        <PostActions post={post} actions={actions} editLabel={editLabel} onEdit={trashed ? undefined : () => onOpen(post)} onChanged={onChanged} noun={noun} />
      )}
    </div>
  )
}
