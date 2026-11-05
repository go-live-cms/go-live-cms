import { useEffect, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import Checkbox from "@gl-admin/components/ui/Checkbox"
import Notice from "@gl-admin/components/ui/Notice"
import MemberPicker from "@gl-admin/components/users/MemberPicker"
import { getPostAuthors, transferPost, type TransferPostResult } from "@gl-admin/lib/api/posts"
import type { PostAuthor, User } from "@gl-admin/lib/api/types"
import { ApiError } from "@gl-admin/lib/api/errors"
import { canOwnPosts, ownerName, replaceInBylineLabel, transferConfirmLine, transferError } from "@gl-admin/lib/postOwner"
import "@gl-admin/assets/styles/components/users/invitations.scss"

interface TransferOwnerModalProps {
  postId: number
  owner: PostAuthor
  me: Pick<User, "id"> | null | undefined
  onClose: () => void
  onTransferred: (result: TransferPostResult) => void
  // The API refused because the owner isn't who this dialog thinks (someone else
  // transferred it meanwhile): the field should reload it.
  onStale?: () => void
}

// Transfer (#353, the Owner field's button; admins only): pick the new owner from the
// members who can own posts (MemberPicker, the remove dialog's picker), optionally put
// them in the old owner's place in the byline, and confirm. The API re-checks open
// editors at once, so a contributor who loses the post drops to read-only.
export default function TransferOwnerModal({ postId, owner, me, onClose, onTransferred, onStale }: TransferOwnerModalProps) {
  const [next, setNext] = useState<User | null>(null)
  const [replace, setReplace] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Whether the owner is in the byline: only then is there a place to give the new owner.
  const [credited, setCredited] = useState(false)

  useEffect(() => {
    let live = true
    getPostAuthors(postId)
      .then((authors) => live && setCredited(authors.some((a) => a.id === owner.id)))
      .catch(() => {
        // Without the byline the option stays hidden; the transfer still works.
      })
    return () => {
      live = false
    }
  }, [postId, owner.id])

  const transfer = async () => {
    if (!next) {
      setError("Choose who will own this post.")
      return
    }
    setError(null)
    setSaving(true)
    try {
      onTransferred(await transferPost(postId, next.id, credited && replace))
    } catch (err) {
      setError(transferError(err))
      setSaving(false)
      if (err instanceof ApiError && (err.code === "already_owner" || err.code === "invalid_owner")) onStale?.()
    }
  }

  return (
    <Modal
      isOpen
      onClose={() => !saving && onClose()}
      size="medium"
      closeOnBackdrop={false}
      title="Transfer this post"
      description={`The owner decides who can edit it. ${ownerName(owner)} owns it now.`}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" loading={saving} disabled={!next} onClick={transfer}>
            Transfer
          </Button>
        </>
      }
    >
      <div className="gl-invite-form">
        <MemberPicker
          label="New owner"
          value={next?.id ?? null}
          onChange={(member) => {
            setNext(member)
            setError(null)
          }}
          me={me}
          exclude={[owner.id]}
          eligible={canOwnPosts}
          disabled={saving}
          emptyMessage="No other member can own posts"
        />
        {credited && (
          <Checkbox label={replaceInBylineLabel(owner, me)} checked={replace} onChange={setReplace} disabled={saving} />
        )}
        {next && (
          <p className="post-owner__confirm" role="status">
            {transferConfirmLine(next, owner, me, credited && replace, credited)}
          </p>
        )}
        {error && (
          <Notice tone="danger" live="alert">
            {error}
          </Notice>
        )}
      </div>
    </Modal>
  )
}
