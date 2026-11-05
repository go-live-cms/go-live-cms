import { useEffect, useState } from "react"
import Avatar from "@gl-admin/components/ui/Avatar"
import { getPostOwner, type TransferPostResult } from "@gl-admin/lib/api/posts"
import type { PostAuthor, User } from "@gl-admin/lib/api/types"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { ownerLabel, transferredNotice } from "@gl-admin/lib/postOwner"
import TransferOwnerModal from "./TransferOwnerModal"

interface PostOwnerProps {
  postId: number
  me: Pick<User, "id"> | null | undefined
  // Admins, on a post that isn't in the trash (canTransferPost).
  canTransfer: boolean
  onTransferred?: (result: TransferPostResult) => void
}

// The Owner field ("Post editor" on the redesign canvas: "Owner · Luan (you) ·
// Transfer", #353). The owner decides access; the Authors field below is the byline.
export default function PostOwner({ postId, me, canTransfer, onTransferred }: PostOwnerProps) {
  const [owner, setOwner] = useState<PostAuthor | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // Bumped when a transfer was refused because the owner changed meanwhile.
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    getPostOwner(postId)
      .then((found) => !cancelled && setOwner(found))
      .catch((error) => !cancelled && setLoadError(errorMessage(error)))
    return () => {
      cancelled = true
    }
  }, [postId, reload])

  if (loadError) return <small className="post-settings__error">{loadError}</small>
  if (!owner) return <small className="post-settings__hint">Loading the owner…</small>

  const label = ownerLabel(owner, me)
  return (
    <>
      <div className="post-owner">
        <Avatar user={{ id: owner.id, name: label, src: owner.avatar }} size={20} decorative />
        <span className="post-owner__name">{label}</span>
        {canTransfer && (
          <button
            type="button"
            className="post-owner__transfer"
            aria-label={`Transfer this post (owner: ${label})`}
            onClick={() => {
              setNotice(null)
              setOpen(true)
            }}
          >
            Transfer
          </button>
        )}
      </div>
      {notice && (
        <small className="post-settings__hint" role="status">
          {notice}
        </small>
      )}
      {open && (
        <TransferOwnerModal
          postId={postId}
          owner={owner}
          me={me}
          onClose={() => setOpen(false)}
          onStale={() => setReload((n) => n + 1)}
          onTransferred={(result) => {
            setOpen(false)
            setOwner(result.owner)
            setNotice(transferredNotice(result.owner, result.byline_changed))
            onTransferred?.(result)
          }}
        />
      )}
    </>
  )
}
