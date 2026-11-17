import { useEffect, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import { toast } from "@gl-admin/components/ui/Toast"
import { getMediaURL } from "@gl-admin/lib/api"
import { deleteMedia, getMediaUsedIn } from "@gl-admin/lib/api/media"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { deleteSiteDesignNotice, isCaptionsFile, siteDesignNames } from "@gl-admin/lib/mediaLibrary"
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

// What deleting takes away. A captions file (#507) is in no post itself: the videos it
// captions lose their captions (the API clears the link).
export function deleteDescription(media: Pick<Media, "mime_type">[]): string {
  if (media.length > 0 && media.every(isCaptionsFile)) return "Videos it captions lose their captions. This can't be undone."
  return "Posts that use it lose the image. This can't be undone."
}

type DeleteMediaDialogProps = {
  // The files to delete; the dialog is open while this is non-empty.
  media: Media[]
  onClose: () => void
  // Called with the ids that were deleted (all of them, or the ones that worked).
  onDeleted: (ids: number[]) => void
}

// The site design's uses of the files being deleted (#496), looked up when the dialog
// opens: the site logo, templates and parts, by name. `checking` while it loads (Delete
// waits for it, so the question names them); a failed lookup names none.
function useSiteDesignNames(media: Media[]): { names: string[]; checking: boolean } {
  const [state, setState] = useState<{ key: string; names: string[] }>({ key: "", names: [] })
  const key = media.map((m) => m.id).join(",")

  useEffect(() => {
    if (!key) return
    let live = true
    const ids = key.split(",").map(Number)
    Promise.all(ids.map((id) => Promise.resolve().then(() => getMediaUsedIn(id)).catch(() => null))).then((results) => {
      if (!live) return
      const names: string[] = []
      for (const usedIn of results) {
        if (!usedIn) continue
        for (const name of siteDesignNames(usedIn)) if (!names.includes(name)) names.push(name)
      }
      setState({ key, names })
    })
    return () => {
      live = false
    }
  }, [key])

  return { names: state.key === key ? state.names : [], checking: !!key && state.key !== key }
}

// Confirms and runs a delete of one file or a selection. Files a post still uses are
// deleted too (the API allows it), so the dialog says so, and names the site design's uses
// (#496): a part or the logo shows on every page.
export function DeleteMediaDialog({ media, onClose, onDeleted }: DeleteMediaDialogProps) {
  const [busy, setBusy] = useState(false)
  const count = media.length
  const title = count === 1 ? `Delete “${media[0].name}”?` : `Delete ${count} files?`
  const siteDesign = useSiteDesignNames(media)
  const notice = deleteSiteDesignNotice(siteDesign.names)

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
      description={deleteDescription(media)}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy || siteDesign.checking} onClick={run}>
            {count === 1 ? "Delete file" : `Delete ${count} files`}
          </Button>
        </>
      }
    >
      {/* In the page empty first, so the names are announced when they arrive. */}
      <p className="gl-media-delete__site" role="status">
        {notice ?? ""}
      </p>
    </Modal>
  )
}
