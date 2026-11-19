import { useEffect, useState } from "react"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import { toast } from "@gl-admin/components/ui/Toast"
import { dismissImportNotice, getImportNotice, type ImportNotice as Notes } from "@gl-admin/lib/api/imports"
import { importNoticeBody, importNoticeTitle, originalText } from "@gl-admin/lib/imports"

// An imported post's "blocks couldn't be kept" notice (#150; the canvas's "Editor notices"
// board, A): what the import left out (and the images it couldn't add), where, and "Copy
// the original as text". The API keeps it until someone dismisses it (GET/POST
// /posts/:id/import-notice, editors and admins). It reads nothing from the doc: the
// blocks were never in it.
export default function ImportNotice({ postId }: { postId: number }) {
  const [notice, setNotice] = useState<Notes | null>(null)

  useEffect(() => {
    let live = true
    getImportNotice(postId)
      .then((n) => live && setNotice(n))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [postId])

  if (!notice || (notice.dropped.length === 0 && notice.media_failed.length === 0)) return null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(originalText(notice.dropped))
      toast.success("Copied the original")
    } catch {
      toast.error("Couldn’t copy to the clipboard")
    }
  }
  const dismiss = async () => {
    const was = notice
    setNotice(null)
    try {
      await dismissImportNotice(postId, was.item_id)
    } catch {
      setNotice(was)
      toast.error("Couldn’t dismiss the notice")
    }
  }

  return (
    <Notice
      tone="warning"
      live="none"
      className="post-editor__notice"
      title={importNoticeTitle(notice)}
      onDismiss={() => void dismiss()}
      actions={
        notice.dropped.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => void copy()}>
            Copy the original as text
          </Button>
        )
      }
    >
      <ul className="post-editor__notice-list">
        {importNoticeBody(notice).map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </Notice>
  )
}
