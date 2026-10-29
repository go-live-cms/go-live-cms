import { useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import { toast } from "@gl-admin/components/ui/Toast"
import { getMediaURL } from "@gl-admin/lib/api"
import { deleteMedia } from "@gl-admin/lib/api/media"
import { errorMessage } from "@gl-admin/lib/api/errors"
import type { Media } from "@gl-admin/lib/types"

// The actions the side panel and the detail page share: copy the URL, download, delete.

// The file's public URL, absolute, as posts and other sites link to it. The plain URL
// (no ?v= version), since this is what gets stored or pasted.
export function absoluteMediaURL(media: Pick<Media, "media_path">): string {
  return new URL(getMediaURL(media.media_path), window.location.origin).href
}

export async function copyMediaURL(media: Pick<Media, "media_path">) {
  try {
    await navigator.clipboard.writeText(absoluteMediaURL(media))
    toast.success("URL copied")
  } catch {
    toast.error("Couldn't copy the URL")
  }
}

export function downloadMedia(media: Pick<Media, "media_path" | "name">) {
  const link = document.createElement("a")
  link.href = absoluteMediaURL(media)
  link.download = media.name || "download"
  document.body.appendChild(link)
  link.click()
  link.remove()
}

type DeleteMediaDialogProps = {
  // The files to delete; the dialog is open while this is non-empty.
  media: Media[]
  onClose: () => void
  // Called with the ids that were deleted (all of them, or the ones that worked).
  onDeleted: (ids: number[]) => void
}

// Confirms and runs a delete of one file or a selection. Files a post still uses are
// deleted too (the API allows it), so the dialog says so.
export function DeleteMediaDialog({ media, onClose, onDeleted }: DeleteMediaDialogProps) {
  const [busy, setBusy] = useState(false)
  const count = media.length
  const title = count === 1 ? `Delete “${media[0].name}”?` : `Delete ${count} files?`

  const run = async () => {
    setBusy(true)
    const results = await Promise.allSettled(media.map((m) => deleteMedia(m.id)))
    setBusy(false)
    const deleted = media.filter((_, i) => results[i].status === "fulfilled").map((m) => m.id)
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected")
    if (failed) {
      const reason = errorMessage(failed.reason, "Delete failed")
      toast.error(deleted.length > 0 ? `Deleted ${deleted.length} of ${count}. ${reason}` : reason)
    } else {
      toast.success(count === 1 ? "File deleted" : `${count} files deleted`)
    }
    if (deleted.length > 0) onDeleted(deleted)
    onClose()
  }

  return (
    <Modal
      isOpen={count > 0}
      onClose={() => !busy && onClose()}
      role="alertdialog"
      size="small"
      title={count > 0 ? title : ""}
      description="Posts that use it lose the image. This can't be undone."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={run}>
            {count === 1 ? "Delete file" : `Delete ${count} files`}
          </Button>
        </>
      }
    >
      {null}
    </Modal>
  )
}
