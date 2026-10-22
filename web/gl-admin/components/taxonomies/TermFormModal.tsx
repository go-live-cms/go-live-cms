import React, { useEffect, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import Input from "@gl-admin/components/ui/Input"
import { Select } from "@gl-admin/components/ui/Select"
import type { TaxonomyTerm, TaxonomyType } from "@gl-admin/lib/api/types"
import { createTaxonomyTerm, updateTaxonomyTerm } from "@gl-admin/lib/api/taxonomies"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import { parentOptions, slugify } from "@gl-admin/lib/taxonomy/terms"

interface TermFormModalProps {
  isOpen: boolean
  type: TaxonomyType
  terms: TaxonomyTerm[]
  // The term being edited; undefined creates a new one.
  term?: TaxonomyTerm
  onClose: () => void
  onSaved: (term: TaxonomyTerm) => void
}

const NO_PARENT = ""

// Create or edit a term: name, slug, description and, for hierarchical types,
// its parent. The API validates the parent and the slug again.
export default function TermFormModal({ isOpen, type, terms, term, onClose, onSaved }: TermFormModalProps) {
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [description, setDescription] = useState("")
  const [parentId, setParentId] = useState(NO_PARENT)
  const [saving, setSaving] = useState(false)
  const [slugError, setSlugError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setName(term?.name ?? "")
    setSlug(term?.slug ?? "")
    setDescription(term?.description ?? "")
    setParentId(term?.parent_id ? String(term.parent_id) : NO_PARENT)
    setSlugError(null)
    setFormError(null)
  }, [isOpen, term])

  const options = [
    { value: NO_PARENT, label: "None (top level)" },
    ...parentOptions(terms, term?.id).map(({ term: t, depth }) => ({
      value: String(t.id),
      label: `${"— ".repeat(depth)}${t.name}`,
    })),
  ]

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim().length < 2) {
      setFormError("The name needs at least 2 characters.")
      return
    }
    setSaving(true)
    setSlugError(null)
    setFormError(null)
    try {
      const parent = type.hierarchical ? Number(parentId || 0) : undefined
      const result = term
        ? await updateTaxonomyTerm(term.id, {
            name: name.trim(),
            slug: slugify(slug) || slugify(name),
            description,
            // 0 moves the term to the top level
            parent_id: parent,
          })
        : await createTaxonomyTerm({
            name: name.trim(),
            // The API only accepts slugs already in this normal form
            slug: slugify(slug) || undefined,
            description: description || undefined,
            taxonomy_type_id: type.id,
            parent_id: parent || undefined,
          })
      onSaved(result.taxonomy_term)
    } catch (error) {
      if (error instanceof ApiError && error.code === "slug_taken") {
        setSlugError("Another term already uses this slug. Slugs are unique across all taxonomies.")
      } else {
        setFormError(errorMessage(error))
      }
    } finally {
      setSaving(false)
    }
  }

  const footer = (
    <div className="gl-term-form__footer">
      <Button variation="flat" onClick={onClose} disabled={saving}>
        Cancel
      </Button>
      <Button variation="primary" type="submit" form="gl-term-form" disabled={saving}>
        {saving ? "Saving…" : term ? "Save changes" : "Create term"}
      </Button>
    </div>
  )

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={term ? `Edit “${term.name}”` : `New term in ${type.label}`}
      size="small"
      footer={footer}
    >
      <form id="gl-term-form" className="gl-term-form" onSubmit={handleSubmit} noValidate>
        <Input title="Name" name="term-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />

        <div className="gl-term-form__field">
          <Input title="Slug" name="term-slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
          <small className="gl-term-form__hint">
            {slug.trim() ? `Saved as “${slugify(slug)}”.` : `Leave empty to use “${slugify(name) || "…"}”.`}
          </small>
          {slugError && <small className="gl-term-form__error">{slugError}</small>}
        </div>

        {type.hierarchical && (
          <div className="gl-term-form__field">
            <span className="gl-term-form__label">Parent</span>
            <Select options={options} value={parentId} onChange={setParentId} bordered />
          </div>
        )}

        <div className="gl-term-form__field">
          <label className="gl-term-form__label" htmlFor="term-description">
            Description
          </label>
          <textarea
            id="term-description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {formError && (
          <p className="gl-term-form__error" role="alert">
            {formError}
          </p>
        )}
      </form>
    </Modal>
  )
}
