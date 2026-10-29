import { useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import Button, { IconButton } from "@gl-admin/components/ui/Button"
import Menu, { MenuItem, MenuSeparator } from "@gl-admin/components/ui/Menu"
import Modal from "@gl-admin/components/ui/Modal"
import Pill from "@gl-admin/components/ui/Pill"
import { PostStatusPill } from "@gl-admin/components/ui/PostStatus"
import { AvatarStack, type AvatarUser } from "@gl-admin/components/ui/Avatar"
import { CheckIcon, ChevronDownIcon, DangerIcon, LockIcon } from "@gl-admin/components/ui/icons"
import type { CollabUser } from "@gl-admin/components/editor/utils/useCollabPresence"
import type { ConnectionView } from "@gl-admin/components/editor/utils/connectionState"
import "@gl-admin/assets/styles/components/editor/editor-top-bar.scss"

// The editor's top bar (#341, "Post editor" on the redesign canvas): breadcrumb and
// status, what is happening to your edits, who's here, settings, view, and the publish
// button with its menu. Everything it does was there before the redesign; features in
// the design without a backend yet (Comments, Schedule…, Move to trash, "N edits
// waiting", click an avatar to jump to its cursor) stay out until their issues land
// (table on #341).

type SaveStatus = "saved" | "saving" | "error" | null

type EditorTopBarProps = {
  // "Posts", "Pages": the breadcrumb's first step, linking back to the list.
  listLabel: string
  listHref: string
  title: string
  postStatus: string
  mode: "create" | "edit"
  saveStatus: SaveStatus
  connection: ConnectionView
  // The socket is up right now (no grace period): publishing needs the server.
  live: boolean
  // Other people in the post (the presence avatars).
  collabUsers: CollabUser[]
  me?: AvatarUser
  viewOnly: boolean
  canPublish: boolean
  isPublishing: boolean
  isSaving: boolean
  settingsOpen: boolean
  onSettingsToggle: () => void
  // Create mode: the post doesn't exist yet, so it's saved by hand.
  onSave: () => void
  onPublish: () => void
  onUnpublish?: () => Promise<void>
  onArchive?: () => Promise<void>
  onRestoreToDrafts?: () => Promise<void>
  // The live page, for a published post.
  liveUrl?: string | null
  // History preview (#136): replaces the actions while a version is shown.
  viewing?: { label: string; onBack: () => void; onRestore: () => void } | null
}

const SpinnerIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="editor-top-bar__spin">
    <path d="M21 12a9 9 0 1 1-6.2-8.55" />
  </svg>
)
const ClockIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)
export const OfflineIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={size > 14 ? 1.75 : 2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 2l20 20" />
    <path d="M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2.3-1.7M2 8.8a15 15 0 0 1 4.2-2.7M22 8.8A15 15 0 0 0 11 5" />
  </svg>
)
const PanelIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M15 3v18" />
  </svg>
)
const EyeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)
const RestoreIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
)
export const ArchiveIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" />
  </svg>
)

// The status next to the actions: always says what is happening to your edits.
export function SaveState({
  mode,
  saveStatus,
  connection,
  viewOnly,
}: Pick<EditorTopBarProps, "mode" | "saveStatus" | "connection" | "viewOnly">) {
  let content: ReactNode = null
  let tone = ""
  // The session-ended dialog says what happened; nothing here is waiting to be sent.
  if (connection === "ended") return null
  if (connection === "connecting") {
    content = (
      <>
        <SpinnerIcon />
        Connecting…
      </>
    )
  } else if (connection === "reconnecting") {
    tone = "reconnecting"
    content = (
      <>
        <SpinnerIcon />
        Reconnecting · edits wait in this tab
      </>
    )
  } else if (connection === "offline") {
    tone = "offline"
    content = (
      <>
        <OfflineIcon />
        {viewOnly ? "Offline" : "Offline · edits wait in this tab"}
      </>
    )
  } else if (viewOnly) {
    return null
  } else if (saveStatus === "error") {
    tone = "error"
    content = (
      <>
        <DangerIcon size={14} />
        Latest edits not saved
      </>
    )
  } else if (saveStatus === "saving") {
    content = (
      <>
        <ClockIcon />
        Saving
      </>
    )
  } else if (mode === "edit") {
    content = (
      <>
        <CheckIcon size={14} />
        Saved
      </>
    )
  }
  return (
    <span role="status" className={`editor-top-bar__save${tone ? ` editor-top-bar__save--${tone}` : ""}`}>
      {content}
    </span>
  )
}

export default function EditorTopBar({
  listLabel,
  listHref,
  title,
  postStatus,
  mode,
  saveStatus,
  connection,
  live,
  collabUsers,
  me,
  viewOnly,
  canPublish,
  isPublishing,
  isSaving,
  settingsOpen,
  onSettingsToggle,
  onSave,
  onPublish,
  onUnpublish,
  onArchive,
  onRestoreToDrafts,
  liveUrl,
  viewing,
}: EditorTopBarProps) {
  const [confirmUnpublish, setConfirmUnpublish] = useState(false)
  const [busy, setBusy] = useState(false)
  const published = postStatus === "published"
  const archived = postStatus === "archived"
  // Publishing needs the server: off until connected (the API flushes the collab server).
  const connected = mode === "create" || live
  const publishDisabled = viewOnly || isSaving || isPublishing || busy || !connected

  // One avatar per person (two tabs are one person), others first, then you.
  const people: AvatarUser[] = []
  for (const u of collabUsers) {
    const id = u.id ?? -u.clientId
    if (people.some((p) => p.id === id) || (me && id === me.id)) continue
    people.push({ id, name: u.name ?? "Guest" })
  }
  if (me && mode === "edit") people.push({ ...me, name: `${me.name} (you)` })

  const run = async (action?: () => Promise<void>) => {
    if (!action) return
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <header className="editor-top-bar">
      <nav aria-label="Breadcrumb" className="editor-top-bar__crumbs">
        <Link to={listHref} className="editor-top-bar__crumb-link">
          {listLabel}
        </Link>
        <span aria-hidden="true" className="editor-top-bar__crumb-sep">
          /
        </span>
        <span aria-current="page" className="editor-top-bar__crumb-title">
          {title.trim() || (mode === "create" ? "New" : "Untitled")}
        </span>
        {viewing ? (
          <Pill tone="info" icon={<ClockIcon />} className="editor-top-bar__pill">
            {viewing.label}
          </Pill>
        ) : (
          <>
            {mode === "edit" && <PostStatusPill status={postStatus || "draft"} />}
            {viewOnly && mode === "edit" && (
              <Pill tone="neutral" icon={<LockIcon size={12} />} className="editor-top-bar__pill">
                View only
              </Pill>
            )}
          </>
        )}
      </nav>

      <div className="editor-top-bar__spacer" />

      <div className="editor-top-bar__actions">
        {viewing ? (
          <>
            <Button variant="secondary" onClick={viewing.onBack}>
              Back to working copy
            </Button>
            {canPublish && !viewOnly && (
              <Button variant="primary" icon={<RestoreIcon />} onClick={viewing.onRestore}>
                Restore this version
              </Button>
            )}
          </>
        ) : (
          <>
            <SaveState mode={mode} saveStatus={saveStatus} connection={connection} viewOnly={viewOnly} />

            {people.length > 0 && (
              <AvatarStack
                users={people}
                max={4}
                size={28}
                label={`${people.length} ${people.length === 1 ? "person" : "people"} in this post`}
                className={`editor-top-bar__people${connection === "online" ? "" : " is-paused"}`}
              />
            )}

            <IconButton
              aria-label="Post settings"
              aria-pressed={settingsOpen}
              icon={<PanelIcon />}
              className={settingsOpen ? "is-pressed" : ""}
              onClick={onSettingsToggle}
            />

            {published && liveUrl && (
              <Button
                as="a"
                variant="secondary"
                href={liveUrl}
                target="_blank"
                rel="noopener noreferrer"
                icon={<EyeIcon />}
                aria-label="View post"
                className="editor-top-bar__view"
              >
                View post
              </Button>
            )}

            {mode === "create" && (
              <Button variant="secondary" onClick={onSave} disabled={isSaving || isPublishing} title="Ctrl+S" loading={isSaving}>
                Save draft
              </Button>
            )}

            {canPublish && archived && mode === "edit" && onRestoreToDrafts && (
              <Button variant="secondary" onClick={() => run(onRestoreToDrafts)} loading={busy} disabled={viewOnly}>
                Restore to drafts
              </Button>
            )}

            {canPublish && !archived && (
              <div className="editor-top-bar__split">
                <Button
                  variant="primary"
                  className="editor-top-bar__split-main"
                  onClick={onPublish}
                  disabled={publishDisabled}
                  loading={isPublishing}
                >
                  {published ? "Update" : "Publish"}
                </Button>
                {mode === "edit" && (onUnpublish || onArchive) && (
                  <Menu
                    label="Publish options"
                    placement="bottom-end"
                    className="editor-top-bar__publish-menu"
                    trigger={(props) => (
                      <button
                        {...props}
                        type="button"
                        aria-label="More publish options"
                        className="editor-top-bar__split-toggle"
                        disabled={viewOnly || busy || isPublishing}
                      >
                        <ChevronDownIcon size={14} />
                      </button>
                    )}
                  >
                    <MenuItem
                      onSelect={onPublish}
                      disabled={publishDisabled}
                      description={published ? "Replace the live post with this version" : "Put this version on the site"}
                    >
                      {published ? "Update now" : "Publish now"}
                    </MenuItem>
                    <MenuSeparator />
                    {published && onUnpublish && (
                      <MenuItem onSelect={() => setConfirmUnpublish(true)} description="Take it off the site and keep it as a draft">
                        Unpublish
                      </MenuItem>
                    )}
                    {onArchive && (
                      <MenuItem onSelect={() => run(onArchive)} description="Take it off the site and out of All posts">
                        Archive
                      </MenuItem>
                    )}
                  </Menu>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <Modal
        isOpen={confirmUnpublish}
        onClose={() => !busy && setConfirmUnpublish(false)}
        role="alertdialog"
        size="small"
        title="Unpublish this post?"
        description="It comes off the site and moves to Drafts. Its link will show your 404 page until you publish it again."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmUnpublish(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                await run(onUnpublish)
                setConfirmUnpublish(false)
              }}
            >
              Unpublish
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </header>
  )
}
