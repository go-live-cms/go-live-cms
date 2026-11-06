import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import { frontPageWarning, type FrontPageAction } from "@gl-admin/lib/frontPage"

// "Unpublish your front page?" (#336): asked before an action that takes the front page
// off the site, so the home page falls back to the latest posts. Used by the Pages row
// menu (PostActions) and the editor's Publish menu (PostForm).
export default function FrontPageConfirm({
  action,
  title,
  busy = false,
  onCancel,
  onConfirm,
}: {
  action: FrontPageAction
  title: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const warning = frontPageWarning(action, title)
  return (
    <Modal
      isOpen
      onClose={() => !busy && onCancel()}
      role="alertdialog"
      size="small"
      title={warning.title}
      description={warning.description}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            {warning.confirm}
          </Button>
        </>
      }
    >
      {null}
    </Modal>
  )
}
