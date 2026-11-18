import { Fragment, type ReactNode } from "react"
import { Link } from "react-router-dom"
import Button, { IconButton } from "@gl-admin/components/ui/Button"
import Menu, { MenuItem, MenuSeparator } from "@gl-admin/components/ui/Menu"
import Pill from "@gl-admin/components/ui/Pill"
import { toast } from "@gl-admin/components/ui/Toast"
import type { AvatarUser } from "@gl-admin/components/ui/Avatar"
import { ChevronLeftIcon, LockIcon, MoreIcon } from "@gl-admin/components/ui/icons"
import { PresenceAvatars, SaveAnnouncer, SaveState, presencePeople } from "@gl-admin/components/editor/ui/EditorTopBar"
import type { CollabUser } from "@gl-admin/components/editor/utils/useCollabPresence"
import type { ConnectionView } from "@gl-admin/components/editor/utils/connectionState"
import { publishButtonLabel, type PillTone, type RowAction } from "@gl-admin/lib/siteDesign"
import "@gl-admin/assets/styles/components/editor/editor-top-bar.scss"

// The template and part editors' top bar (#493; the boards "Site editor · template" and
// "· template part"): the post editor's chrome (#341) with a template breadcrumb ("Site editor
// / Templates / Archive"), its status pill, what's happening to the edits (SaveState, and the
// one live region SaveAnnouncer, #477), who's here (#356's avatars, a click jumps to their
// caret), the View switch (Edit · Split · Preview), the settings toggle, the More menu and
// Publish site design with its count.

export type EditorView = "edit" | "split" | "preview"

type Props = {
  kind: "template" | "part"
  name: string
  pill: { label: string; tone: PillTone }
  viewOnly: boolean
  saveStatus: "saved" | "saving" | "error" | null
  connection: ConnectionView
  unsyncedCount: number
  collabUsers: CollabUser[]
  me?: AvatarUser
  onJumpToCursor?: (clientIds: number[]) => boolean
  view: EditorView
  onViewChange: (view: EditorView) => void
  settingsOpen: boolean
  onSettingsToggle: () => void
  actions: RowAction[]
  onAction: (id: RowAction["id"]) => void
  publishCount: number
  onPublish: () => void
  /** The template this part was opened from (its card): the way back (design 13.1). */
  back?: { label: string; to: string } | null
  /** "Used in 7 templates" (a part): a button that lists them. */
  usedIn?: ReactNode
}

export default function SiteEditorTopBar({
  kind,
  name,
  pill,
  viewOnly,
  saveStatus,
  connection,
  unsyncedCount,
  collabUsers,
  me,
  onJumpToCursor,
  view,
  onViewChange,
  settingsOpen,
  onSettingsToggle,
  actions,
  onAction,
  publishCount,
  onPublish,
  back,
  usedIn,
}: Props) {
  const people = presencePeople(collabUsers, me)
  const jump = onJumpToCursor
    ? (person: { name: string; clientIds: number[] }) => {
        if (!onJumpToCursor(person.clientIds)) toast.info(`${person.name} isn't in the text right now`)
      }
    : undefined
  const views: { id: EditorView; label: string }[] = [
    { id: "edit", label: "Edit" },
    { id: "split", label: "Split" },
    { id: "preview", label: "Preview" },
  ]

  return (
    <header className="editor-top-bar site-editor-top-bar">
      <SaveAnnouncer connection={connection} saveStatus={saveStatus} viewOnly={viewOnly} />
      {back && (
        <>
          <Link to={back.to} className="gl-button gl-button--ghost gl-button--sm site-editor-top-bar__back">
            <ChevronLeftIcon size={16} />
            {back.label}
          </Link>
          <span className="site-editor-top-bar__divider" aria-hidden="true" />
        </>
      )}
      <nav aria-label="Breadcrumb" className="editor-top-bar__crumbs">
        <Link to="/site-editor" className="editor-top-bar__crumb-link">
          Site editor
        </Link>
        <span aria-hidden="true" className="editor-top-bar__crumb-sep">
          /
        </span>
        <Link to="/site-editor" className="editor-top-bar__crumb-link">
          {kind === "part" ? "Template parts" : "Templates"}
        </Link>
        <span aria-hidden="true" className="editor-top-bar__crumb-sep">
          /
        </span>
        <span aria-current="page" className="editor-top-bar__crumb-title">
          {name}
        </span>
        <Pill tone={pill.tone} className="editor-top-bar__pill">
          {pill.label}
        </Pill>
        {viewOnly && (
          <Pill tone="neutral" icon={<LockIcon size={12} />} className="editor-top-bar__pill">
            View only
          </Pill>
        )}
      </nav>
      {usedIn}

      <div className="editor-top-bar__spacer" />

      <div className="editor-top-bar__actions">
        <SaveState mode="edit" saveStatus={saveStatus} connection={connection} viewOnly={viewOnly} unsyncedCount={unsyncedCount} />
        {people.length > 0 && <PresenceAvatars people={people} max={4} paused={connection !== "online"} onJump={jump} where={kind} />}
        <div className="gl-segmented" role="group" aria-label="View">
          {views.map((option) => (
            <button key={option.id} type="button" aria-pressed={view === option.id} onClick={() => onViewChange(option.id)}>
              {option.label}
            </button>
          ))}
        </div>
        <IconButton
          variant="ghost"
          aria-label={kind === "part" ? "Part settings" : "Template settings"}
          aria-pressed={settingsOpen}
          onClick={onSettingsToggle}
          icon={<PanelIcon />}
        />
        <Menu
          label={`More for ${name}`}
          placement="bottom-end"
          trigger={(props) => <IconButton {...props} variant="ghost" aria-label={`More for ${name}`} icon={<MoreIcon size={16} />} />}
        >
          {actions.map((action, index) => (
            <Fragment key={action.id}>
              {index > 0 && actions[index - 1].id === "history" && <MenuSeparator />}
              <MenuItem onSelect={() => onAction(action.id)} disabled={action.disabled} danger={action.danger} description={action.hint}>
                {action.label}
              </MenuItem>
            </Fragment>
          ))}
        </Menu>
        <Button variant="primary" onClick={onPublish} disabled={publishCount === 0} aria-label={publishButtonLabel(publishCount)}>
          Publish site design
          {publishCount > 0 && (
            <span className="site-editor__count" aria-hidden="true">
              {publishCount}
            </span>
          )}
        </Button>
      </div>
    </header>
  )
}

const PanelIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M15 3v18" />
  </svg>
)
