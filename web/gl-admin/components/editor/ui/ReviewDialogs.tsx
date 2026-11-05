import { useEffect, useRef, useState } from "react"
import Button from "@gl-admin/components/ui/Button"
import Modal from "@gl-admin/components/ui/Modal"
import Select from "@gl-admin/components/ui/Select"
import Textarea from "@gl-admin/components/ui/Textarea"
import { getReviewers, type ReviewPerson } from "@gl-admin/lib/api/reviewRequests"
import { ANY_REVIEWER, REVIEW_MESSAGE_MAX, REVIEW_NOTE_MAX, reviewerOptions } from "@gl-admin/lib/reviewRequests"

// The two review dialogs (#323), owned by PostForm: Request review (an optional
// reviewer and note) and Request changes (a note, required). Built from the #338
// components (Modal, Select, Textarea, Button); the canvas doesn't draw them. A
// rejection is shown in the dialog, which stays open.

type RequestReviewProps = {
  isOpen: boolean
  onClose: () => void
  meId: number | null | undefined
  onSubmit: (body: { reviewer_id?: number; message?: string }) => Promise<void>
}

export function RequestReviewDialog({ isOpen, onClose, meId, onSubmit }: RequestReviewProps) {
  const [reviewers, setReviewers] = useState<ReviewPerson[]>([])
  const [reviewer, setReviewer] = useState(ANY_REVIEWER)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!isOpen) return
    setReviewer(ANY_REVIEWER)
    setMessage("")
    setError(null)
    let live = true
    // Without the list, "Any editor or admin" still works.
    getReviewers()
      .then((list) => live && setReviewers(list))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [isOpen])

  const tooLong = [...message].length > REVIEW_MESSAGE_MAX
  const submit = async () => {
    if (tooLong) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit({
        ...(reviewer !== ANY_REVIEWER ? { reviewer_id: Number(reviewer) } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !busy && onClose()}
      size="small"
      title="Request review"
      description="An editor or admin reviews it and publishes it, or asks for changes. They're emailed and see it on Home."
      initialFocus={messageRef}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={tooLong}>
            Request review
          </Button>
        </>
      }
    >
      <div className="post-editor__review-form">
        <Select label="Reviewer" options={reviewerOptions(reviewers, meId)} value={reviewer} onChange={setReviewer} />
        <Textarea
          ref={messageRef}
          label="Note for the reviewer"
          optional
          rows={4}
          maxCount={REVIEW_MESSAGE_MAX}
          value={message}
          onChange={(e) => setMessage(e.currentTarget.value)}
          error={error ?? undefined}
        />
      </div>
    </Modal>
  )
}

type RequestChangesProps = {
  isOpen: boolean
  onClose: () => void
  requesterName: string
  onSubmit: (note: string) => Promise<void>
}

export function RequestChangesDialog({ isOpen, onClose, requesterName, onSubmit }: RequestChangesProps) {
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!isOpen) return
    setNote("")
    setError(null)
    setTouched(false)
  }, [isOpen])

  const blank = !note.trim()
  const tooLong = [...note].length > REVIEW_NOTE_MAX
  const submit = async () => {
    setTouched(true)
    if (blank || tooLong) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(note.trim())
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !busy && onClose()}
      size="small"
      title="Request changes"
      description={`${requesterName || "The requester"} is emailed your note. The request closes; they can ask again after the changes.`}
      initialFocus={noteRef}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            Request changes
          </Button>
        </>
      }
    >
      <Textarea
        ref={noteRef}
        label="What should change?"
        rows={5}
        maxCount={REVIEW_NOTE_MAX}
        value={note}
        onChange={(e) => setNote(e.currentTarget.value)}
        error={error ?? (touched && blank ? "Write a note for the author." : undefined)}
      />
    </Modal>
  )
}
