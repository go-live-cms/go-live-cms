import React, { useEffect, useState } from "react"
import Button from "@gl-admin/components/ui/Button"
import Input from "@gl-admin/components/ui/Input"
import Textarea from "@gl-admin/components/ui/Textarea"
import Notice from "@gl-admin/components/ui/Notice"
import { Select } from "@gl-admin/components/ui/Select"
import type { TaxonomyTerm, TaxonomyType } from "@gl-admin/lib/api/types"
import { createTaxonomyTerm, updateTaxonomyTerm } from "@gl-admin/lib/api/taxonomies"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import { parentOptions, slugify } from "@gl-admin/lib/taxonomy/terms"

interface TermFormProps {
  type: TaxonomyType
  terms: TaxonomyTerm[]
  // The term being edited; undefined creates a new one.
  term?: TaxonomyTerm
  // Closes the panel (editing), or clears the form (creating).
  onCancel: () => void
  onSaved: (term: TaxonomyTerm) => void
  onDelete?: (term: TaxonomyTerm) => void
}

const NO_PARENT = ""

// Create or edit a term (#167; the panel beside the list since #343): name, slug,
// description and, for hierarchical types, its parent. The API validates the parent
// and the slug again.
export default function TermForm({ type, terms, term, onCancel, onSaved, onDelete }: TermFormProps) {
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [description, setDescription] = useState("")
  const [parentId, setParentId] = useState(NO_PARENT)
  const [saving, setSaving] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [slugError, setSlugError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const reset = () => {
    setName(term?.name ?? "")
    setSlug(term?.slug ?? "")
    setDescription(term?.description ?? "")
    setParentId(term?.parent_id ? String(term.parent_id) : NO_PARENT)
    setNameError(null)
    setSlugError(null)
    setFormError(null)
  }

  // Only for another term: a reload of the list hands in a new object for the same one.
  useEffect(reset, [term?.id])

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
      setNameError("The name needs at least 2 characters.")
      return
    }
    setSaving(true)
    setNameError(null)
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
      if (!term) {
        setName("")
        setSlug("")
        setDescription("")
        setParentId(NO_PARENT)
      }
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

  const cancel = () => {
    reset()
    onCancel()
  }

  const titleId = `gl-term-form-title-${term?.id ?? "new"}`
  const slugHint = slug.trim() ? `Saved as “${slugify(slug)}”.` : `Leave empty to use “${slugify(name) || "…"}”.`

  return (
    <form className="gl-workspace__panel gl-term-form" onSubmit={handleSubmit} noValidate aria-labelledby={titleId}>
      <h2 id={titleId}>{term ? `Edit “${term.name}”` : `New ${singular(type)}`}</h2>
      <Input
        title="Name"
        name="term-name"
        id={`term-name-${term?.id ?? "new"}`}
        value={name}
        error={nameError}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        title="Slug"
        name="term-slug"
        id={`term-slug-${term?.id ?? "new"}`}
        value={slug}
        hint={slugHint}
        error={slugError}
        onChange={(e) => setSlug(e.target.value)}
      />
      {type.hierarchical && <Select label="Parent" options={options} value={parentId} onChange={setParentId} />}
      <Textarea
        label="Description"
        id={`term-description-${term?.id ?? "new"}`}
        rows={3}
        optional
        hint="Shown on the term's page if your theme supports it."
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      {formError && (
        <Notice tone="danger" live="alert">
          {formError}
        </Notice>
      )}
      <div className="gl-workspace__panel-actions">
        {term && onDelete && (
          <Button variant="ghost" className="gl-button--danger-text" onClick={() => onDelete(term)} disabled={saving}>
            Delete
          </Button>
        )}
        <span className="gl-workspace__spacer" />
        <Button variant="secondary" onClick={cancel} disabled={saving}>
          {term ? "Cancel" : "Clear"}
        </Button>
        <Button variant="primary" type="submit" loading={saving}>
          {term ? "Save" : `Add ${singular(type)}`}
        </Button>
      </div>
    </form>
  )
}

// "category" from "Categories": the types only carry a plural label.
export function singular(type: Pick<TaxonomyType, "label" | "name">): string {
  const label = type.label.trim()
  const lower = label.toLowerCase()
  if (lower.endsWith("ies")) return lower.slice(0, -3) + "y"
  if (lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1)
  return lower || type.name
}
