import { useState } from "react"
import Menu, { MenuItem, MenuSeparator } from "@gl-admin/components/ui/Menu"
import Modal from "@gl-admin/components/ui/Modal"
import Button, { IconButton } from "@gl-admin/components/ui/Button"
import { MoreIcon } from "@gl-admin/components/ui/icons"
import { toast } from "@gl-admin/components/ui/Toast"
import { deletePost, updatePost } from "@gl-admin/lib/api/posts"
import { blockAPIClient } from "@gl-admin/lib/api/blockAPI"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { authManager } from "@gl-admin/lib/auth"
import type { RowAction } from "@gl-admin/lib/contentList"
import type { Post } from "@gl-admin/lib/api/types"

// The Posts and Pages rows' actions menu (#340): edit, then whichever of publish /
// unpublish / archive / delete the user may do (rowActions). Delete asks first.

const DESCRIPTIONS: Record<RowAction, string | undefined> = {
  publish: "Put the current version on the site",
  unpublish: "Take it off the site, keep it as a draft",
  archive: "Hide from the site and from All",
  delete: undefined,
}

const LABELS: Record<RowAction, string> = { publish: "Publish", unpublish: "Unpublish", archive: "Archive", delete: "Delete" }

const DONE: Record<RowAction, string> = {
  publish: "published",
  unpublish: "unpublished",
  archive: "archived",
  delete: "deleted",
}

async function perform(action: RowAction, post: Post) {
  const token = authManager.getAccessToken()
  if (token) blockAPIClient.setAuthToken(token)
  switch (action) {
    case "publish":
      return blockAPIClient.publishPost(post.id)
    case "unpublish":
      return blockAPIClient.unpublishPost(post.id)
    case "archive":
      return updatePost(post.id, { post_status: "archived" })
    case "delete":
      return deletePost(post.id)
  }
}

type PostActionsProps = {
  post: Post
  actions: RowAction[]
  // "Edit" or "Open" (view-only), first in the menu.
  editLabel: string
  onEdit: () => void
  // After an action succeeds, so the list and its counts reload.
  onChanged: () => void
  // "post" or "page", in the confirmation.
  noun?: string
}

export default function PostActions({ post, actions, editLabel, onEdit, onChanged, noun = "post" }: PostActionsProps) {
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const title = post.title || "Untitled"

  const run = async (action: RowAction) => {
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

  const statusActions = actions.filter((a) => a !== "delete")

  return (
    <>
      <Menu
        label={`Actions for ${title}`}
        placement="bottom-end"
        trigger={(props) => (
          <IconButton {...props} size="sm" aria-label={`Actions for ${title}`} icon={<MoreIcon />} disabled={busy} />
        )}
      >
        <MenuItem onSelect={onEdit}>{editLabel}</MenuItem>
        {statusActions.length > 0 && <MenuSeparator />}
        {statusActions.map((a) => (
          <MenuItem key={a} description={DESCRIPTIONS[a]} onSelect={() => run(a)}>
            {LABELS[a]}
          </MenuItem>
        ))}
        {actions.includes("delete") && (
          <>
            <MenuSeparator />
            <MenuItem danger onSelect={() => setConfirmDelete(true)}>
              Delete
            </MenuItem>
          </>
        )}
      </Menu>
      <Modal
        isOpen={confirmDelete}
        onClose={() => !busy && setConfirmDelete(false)}
        role="alertdialog"
        size="small"
        title={`Delete “${title}”?`}
        description={`The ${noun} is removed from the site and the admin. This can't be undone.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => run("delete")}>
              Delete {noun}
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </>
  )
}
