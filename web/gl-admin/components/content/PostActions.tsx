import { useState } from "react"
import { useNavigate } from "react-router-dom"
import Menu, { MenuItem, MenuSeparator } from "@gl-admin/components/ui/Menu"
import Modal from "@gl-admin/components/ui/Modal"
import Button, { IconButton } from "@gl-admin/components/ui/Button"
import { MoreIcon } from "@gl-admin/components/ui/icons"
import { toast } from "@gl-admin/components/ui/Toast"
import { deletePostPermanently, duplicatePost, restorePost, trashPost, updatePost } from "@gl-admin/lib/api/posts"
import { blockAPIClient } from "@gl-admin/lib/api/blockAPI"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { authManager } from "@gl-admin/lib/auth"
import { DUPLICATED_MESSAGE, type RowAction } from "@gl-admin/lib/contentList"
import type { Post } from "@gl-admin/lib/api/types"

// The Posts and Pages rows' actions menu (#340): edit and duplicate (#354), then
// whichever of publish / unpublish / archive / move to trash the user may do
// (rowActions). In the trash (#327): restore, and delete permanently, which asks first.
// Duplicate opens the copy in the editor.

// The actions that change this post and reload the list.
type ListAction = Exclude<RowAction, "duplicate">

const DESCRIPTIONS: Record<ListAction, string | undefined> = {
  publish: "Put the current version on the site",
  unpublish: "Take it off the site, keep it as a draft",
  archive: "Hide from the site and from All",
  trash: "Off the site and out of the lists; restore it from Trash",
  restore: "Back with the status it had",
  delete: undefined,
}

const LABELS: Record<ListAction, string> = {
  publish: "Publish",
  unpublish: "Unpublish",
  archive: "Archive",
  trash: "Move to trash",
  restore: "Restore",
  delete: "Delete permanently",
}

const DONE: Record<ListAction, string> = {
  publish: "published",
  unpublish: "unpublished",
  archive: "archived",
  trash: "moved to the trash",
  restore: "restored",
  delete: "deleted permanently",
}

async function perform(action: ListAction, post: Post) {
  const token = authManager.getAccessToken()
  if (token) blockAPIClient.setAuthToken(token)
  switch (action) {
    case "publish":
      return blockAPIClient.publishPost(post.id)
    case "unpublish":
      return blockAPIClient.unpublishPost(post.id)
    case "archive":
      return updatePost(post.id, { post_status: "archived" })
    case "trash":
      return trashPost(post.id)
    case "restore":
      return restorePost(post.id)
    case "delete":
      return deletePostPermanently(post.id)
  }
}

type PostActionsProps = {
  post: Post
  actions: RowAction[]
  // "Edit" or "Open" (view-only), first in the menu.
  editLabel: string
  // Absent for a trashed post (#327): it opens nowhere until restored.
  onEdit?: () => void
  // After an action succeeds, so the list and its counts reload.
  onChanged: () => void
  // "post" or "page", in the confirmation.
  noun?: string
}

export default function PostActions({ post, actions, editLabel, onEdit, onChanged, noun = "post" }: PostActionsProps) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const title = post.title || "Untitled"

  const duplicate = async () => {
    setBusy(true)
    try {
      const { post: copy } = await duplicatePost(post.id)
      toast.success(DUPLICATED_MESSAGE)
      navigate(`/content/edit/${copy.id}`)
    } catch (e) {
      toast.error(errorMessage(e, `Couldn't duplicate “${title}”`))
      setBusy(false)
    }
  }

  const run = async (action: ListAction) => {
    setBusy(true)
    try {
      await perform(action, post)
      toast.success(`“${title}” ${DONE[action]}`)
      setConfirmDelete(false)
      onChanged()
    } catch (e) {
      toast.error(errorMessage(e, `Couldn't ${LABELS[action].toLowerCase()} “${title}”`))
    } finally {
      setBusy(false)
    }
  }

  // Move to trash and Delete permanently go last, after a separator.
  const statusActions = actions.filter((a): a is ListAction => a !== "delete" && a !== "duplicate" && a !== "trash")

  return (
    <>
      <Menu
        label={`Actions for ${title}`}
        placement="bottom-end"
        trigger={(props) => (
          <IconButton {...props} size="sm" aria-label={`Actions for ${title}`} icon={<MoreIcon />} disabled={busy} />
        )}
      >
        {onEdit && <MenuItem onSelect={onEdit}>{editLabel}</MenuItem>}
        {actions.includes("duplicate") && (
          <MenuItem description="A new draft you own, with the same content" onSelect={duplicate}>
            Duplicate
          </MenuItem>
        )}
        {statusActions.length > 0 && <MenuSeparator />}
        {statusActions.map((a) => (
          <MenuItem key={a} description={DESCRIPTIONS[a]} onSelect={() => run(a)}>
            {LABELS[a]}
          </MenuItem>
        ))}
        {actions.includes("trash") && (
          <>
            <MenuSeparator />
            <MenuItem description={DESCRIPTIONS.trash} onSelect={() => run("trash")}>
              {LABELS.trash}
            </MenuItem>
          </>
        )}
        {actions.includes("delete") && (
          <>
            <MenuSeparator />
            <MenuItem danger onSelect={() => setConfirmDelete(true)}>
              {LABELS.delete}
            </MenuItem>
          </>
        )}
      </Menu>
      <Modal
        isOpen={confirmDelete}
        onClose={() => !busy && setConfirmDelete(false)}
        role="alertdialog"
        size="small"
        title={`Delete “${title}” permanently?`}
        description={`The ${noun} and its revisions are deleted. This can't be undone.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => run("delete")}>
              Delete permanently
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </>
  )
}
