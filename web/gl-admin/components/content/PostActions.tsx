import { useState } from "react"
import { useNavigate } from "react-router-dom"
import Menu, { MenuItem, MenuSeparator } from "@gl-admin/components/ui/Menu"
import Modal from "@gl-admin/components/ui/Modal"
import Button, { IconButton } from "@gl-admin/components/ui/Button"
import { MoreIcon } from "@gl-admin/components/ui/icons"
import { toast } from "@gl-admin/components/ui/Toast"
import SaveTemplateDialog from "@gl-admin/components/content/SaveTemplateDialog"
import { deletePostPermanently, duplicatePost, restorePost, trashPost, updatePost } from "@gl-admin/lib/api/posts"
import { blockAPIClient } from "@gl-admin/lib/api/blockAPI"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { authManager } from "@gl-admin/lib/auth"
import { DUPLICATED_MESSAGE, type RowAction } from "@gl-admin/lib/contentList"
import { frontPageSetMessage, takesFrontPageOffSite, type FrontPageAction } from "@gl-admin/lib/frontPage"
import FrontPageConfirm from "@gl-admin/components/content/FrontPageConfirm"
import type { Post } from "@gl-admin/lib/api/types"

// The Posts and Pages rows' actions menu (#340): edit and duplicate (#354), then
// whichever of publish / unpublish / archive / move to trash the user may do
// (rowActions). In the trash (#327): restore, and delete permanently, which asks first.
// Duplicate opens the copy in the editor. Save as template… (#322, moderators) opens
// SaveTemplateDialog.

// The actions that change this post and reload the list.
type ListAction = Exclude<RowAction, "duplicate" | "template">

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
  // The front page (#336), from the Pages list: `isFront` asks before unpublishing,
  // archiving or trashing it (the home page falls back to the latest posts); `onSet`
  // (admins, on a published page that isn't it) adds "Set as front page".
  frontPage?: FrontPageRow
}

export type FrontPageRow = {
  isFront: boolean
  onSet?: () => Promise<void>
}

export default function PostActions({ post, actions, editLabel, onEdit, onChanged, noun = "post", frontPage }: PostActionsProps) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // The action waiting for "yes" because it takes the front page off the site.
  const [confirmFront, setConfirmFront] = useState<FrontPageAction | null>(null)
  const [savingTemplate, setSavingTemplate] = useState(false)
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

  // Unpublish, archive and trash ask first on the front page.
  const choose = (action: ListAction) => {
    if (frontPage?.isFront && takesFrontPageOffSite(action)) {
      setConfirmFront(action)
      return
    }
    void run(action)
  }

  const setAsFrontPage = async () => {
    if (!frontPage?.onSet) return
    setBusy(true)
    try {
      await frontPage.onSet()
      toast.success(frontPageSetMessage(title))
    } catch (e) {
      toast.error(errorMessage(e, `Couldn't make “${title}” the front page`))
    } finally {
      setBusy(false)
    }
  }

  const run = async (action: ListAction) => {
    setBusy(true)
    try {
      await perform(action, post)
      toast.success(`“${title}” ${DONE[action]}`)
      setConfirmDelete(false)
      setConfirmFront(null)
      onChanged()
    } catch (e) {
      toast.error(errorMessage(e, `Couldn't ${LABELS[action].toLowerCase()} “${title}”`))
    } finally {
      setBusy(false)
    }
  }

  // Move to trash and Delete permanently go last, after a separator.
  const statusActions = actions.filter((a): a is ListAction => a !== "delete" && a !== "duplicate" && a !== "template" && a !== "trash")

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
        {actions.includes("template") && (
          <MenuItem description={`Start new ${noun}s from its content`} onSelect={() => setSavingTemplate(true)}>
            Save as template…
          </MenuItem>
        )}
        {frontPage?.onSet && (
          <MenuItem description="Show this page at your site's home address" onSelect={setAsFrontPage}>
            Set as front page
          </MenuItem>
        )}
        {statusActions.length > 0 && <MenuSeparator />}
        {statusActions.map((a) => (
          <MenuItem key={a} description={DESCRIPTIONS[a]} onSelect={() => choose(a)}>
            {LABELS[a]}
          </MenuItem>
        ))}
        {actions.includes("trash") && (
          <>
            <MenuSeparator />
            <MenuItem description={DESCRIPTIONS.trash} onSelect={() => choose("trash")}>
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
      <SaveTemplateDialog isOpen={savingTemplate} post={post} noun={noun} onClose={() => setSavingTemplate(false)} />
      {confirmFront && (
        <FrontPageConfirm
          action={confirmFront}
          title={title}
          busy={busy}
          onCancel={() => setConfirmFront(null)}
          onConfirm={() => run(confirmFront)}
        />
      )}
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
