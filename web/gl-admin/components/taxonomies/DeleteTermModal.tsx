import { useEffect, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import type { TaxonomyTerm } from "@gl-admin/lib/api/types"
import { deleteTaxonomyTerm } from "@gl-admin/lib/api/taxonomies"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import { deleteConsequences } from "@gl-admin/lib/taxonomy/terms"

interface DeleteTermModalProps {
  term: TaxonomyTerm | null
  childCount: number
  onClose: () => void
  onDeleted: () => void
  // The term turned out to be in use after all (assigned since the list loaded):
  // the parent reloads the list so the dialog shows the real count.
  onStale: () => void
}

export default function DeleteTermModal({ term, childCount, onClose, onDeleted, onStale }: DeleteTermModalProps) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset only for a different term: the reload after a 409 hands in a new
  // object for the same one, and its explanation must stay visible.
  useEffect(() => setError(null), [term?.id])

  if (!term) return null

  const inUse = (term.post_count ?? 0) > 0

  const handleDelete = async () => {
    setDeleting(true)
    setError(null)
    try {
      // Only force when the user was told about the posts: an unforced delete
      // of a term that has been assigned meanwhile gets a 409 instead.
      await deleteTaxonomyTerm(term.id, inUse)
      onDeleted()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("Posts started using this term while this dialog was open. Check the updated count and confirm again.")
        onStale()
      } else {
        setError(errorMessage(err))
      }
    } finally {
      setDeleting(false)
    }
  }

  const footer = (
    <div className="gl-term-form__footer">
      <Button variation="flat" onClick={onClose} disabled={deleting}>
        Cancel
      </Button>
      <Button variation="danger" onClick={handleDelete} disabled={deleting}>
        {deleting ? "Deleting…" : inUse ? "Delete and unassign" : "Delete term"}
      </Button>
    </div>
  )

  return (
    <Modal isOpen onClose={onClose} title={`Delete “${term.name}”?`} size="small" footer={footer}>
      <div className="gl-term-form">
        <ul className="gl-term-form__warning">
          {deleteConsequences(term, childCount).map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>This can't be undone.</li>
        </ul>
        {error && (
          <p className="gl-term-form__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
