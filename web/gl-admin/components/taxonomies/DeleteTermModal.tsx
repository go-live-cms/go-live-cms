import { useEffect, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import type { TaxonomyTerm } from "@gl-admin/lib/api/types"
import { deleteTaxonomyTerm } from "@gl-admin/lib/api/taxonomies"
import { ApiError } from "@gl-admin/lib/api/errors"
import { bulkDeleteConsequences, deleteConsequences } from "@gl-admin/lib/taxonomy/terms"
import { termErrorMessage } from "@gl-admin/lib/taxonomyAdmin"
import { plural } from "@gl-admin/utils/formatting"

interface DeleteTermModalProps {
  // The terms to delete: one from the edit panel, or the tags selected in the list
  // (#331). Empty = closed.
  terms: TaxonomyTerm[]
  childCount: (id: number) => number
  // A category's posts move to the default category (#331): its name.
  movesTo?: string
  // "tag" / "tags", for the title of a bulk delete.
  noun?: string
  nouns?: string
  onClose: () => void
  // Every term was deleted.
  onDeleted: () => void
  // The list must reload: a term turned out to be in use after all (assigned since the
  // list loaded), so the dialog shows the real count, or some were deleted before one failed.
  onStale: () => void
}

export default function DeleteTermModal({ terms, childCount, movesTo, noun = "term", nouns = "terms", onClose, onDeleted, onStale }: DeleteTermModalProps) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset only once closed: the reload after a 409 (or a partial bulk delete) hands in
  // new objects, or fewer terms, and the explanation must stay visible.
  const open = terms.length > 0
  useEffect(() => {
    if (!open) setError(null)
  }, [open])

  if (terms.length === 0) return null

  const single = terms.length === 1 ? terms[0] : null
  const inUse = terms.some((t) => (t.post_count ?? 0) > 0)

  // One by one through the same route as a single delete; stops at the first failure.
  const handleDelete = async () => {
    setDeleting(true)
    setError(null)
    let done = 0
    try {
      for (const term of terms) {
        // Only force when the user was told about the posts: an unforced delete
        // of a term that has been assigned meanwhile gets a 409 instead.
        await deleteTaxonomyTerm(term.id, (term.post_count ?? 0) > 0)
        done++
      }
      onDeleted()
    } catch (err) {
      const failed = terms[done]
      const prefix = single ? "" : `Deleted ${done} of ${terms.length}. Couldn’t delete “${failed.name}”: `
      if (err instanceof ApiError && err.status === 409 && err.code !== "default_term") {
        setError(`${prefix}Posts started using ${single ? "this term" : "it"} while this dialog was open. Check the updated count and confirm again.`)
        onStale()
      } else {
        setError(`${prefix}${termErrorMessage(err, "delete").message}`)
        if (done > 0) onStale()
      }
    } finally {
      setDeleting(false)
    }
  }

  const confirmLabel = single
    ? inUse
      ? movesTo
        ? "Delete and move posts"
        : "Delete and unassign"
      : "Delete term"
    : `Delete ${plural(terms.length, noun, nouns)}`

  const footer = (
    <div className="gl-term-form__footer">
      <Button variant="secondary" onClick={onClose} disabled={deleting}>
        Cancel
      </Button>
      <Button variant="danger" onClick={handleDelete} loading={deleting}>
        {confirmLabel}
      </Button>
    </div>
  )

  const lines = single ? deleteConsequences(single, childCount(single.id), movesTo) : bulkDeleteConsequences(terms)
  const title = single ? `Delete “${single.name}”?` : `Delete ${plural(terms.length, noun, nouns)}?`

  return (
    <Modal isOpen onClose={onClose} title={title} size="small" footer={footer} role="alertdialog">
      <div className="gl-workspace__form">
        {!single && (
          <p className="gl-term-form__names">{terms.map((t) => t.name).join(", ")}</p>
        )}
        <ul className="gl-term-form__warning">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>This can't be undone.</li>
        </ul>
        {error && (
          <Notice tone="danger" live="alert">
            {error}
          </Notice>
        )}
      </div>
    </Modal>
  )
}
