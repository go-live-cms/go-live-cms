import React, { useState } from "react"
import Button from "@gl-admin/components/ui/Button"
import Input, { FieldMessage, describedBy } from "@gl-admin/components/ui/Input"
import Textarea from "@gl-admin/components/ui/Textarea"
import Notice from "@gl-admin/components/ui/Notice"
import { Select } from "@gl-admin/components/ui/Select"
import type { TaxonomyTerm, TaxonomyType } from "@gl-admin/lib/api/types"
import type { PostUrlStructure } from "@gl-admin/lib/api/settings"
import { createTaxonomyTerm, updateTaxonomyTerm } from "@gl-admin/lib/api/taxonomies"
import { slugify } from "@gl-admin/lib/taxonomy/terms"
import { isDefaultTerm, nestsOneLevel, parentHint, singularTaxonomyLabel as singular, slugHint, slugPrefix, termErrorMessage, termParentOptions } from "@gl-admin/lib/taxonomyAdmin"

interface TermFormProps {
  type: TaxonomyType
  terms: TaxonomyTerm[]
  // The term being edited; undefined creates a new one.
  term?: TaxonomyTerm
  // The site's post URL structure (#331): categories start post URLs under "category".
  structure?: PostUrlStructure
  // Closes the panel (editing), or clears the form (creating).
  onCancel: () => void
  onSaved: (term: TaxonomyTerm) => void
  onDelete?: (term: TaxonomyTerm) => void
}

const NO_PARENT = ""

// Create or edit a term (#167; the panel beside the list since #343): name, slug,
// description and, for hierarchical types, its parent. Since #331: categories nest one
// level, the slug shows the address it's part of and what changing it does (the API adds
// the redirect), and the default category can't be deleted. The API validates the parent
// and the slug again.
export default function TermForm({ type, terms, term, structure, onCancel, onSaved, onDelete }: TermFormProps) {
  // The page keys this form by term, so these start from the term picked.
  const [name, setName] = useState(term?.name ?? "")
  const [slug, setSlug] = useState(term?.slug ?? "")
  const [description, setDescription] = useState(term?.description ?? "")
  const [parentId, setParentId] = useState(term?.parent_id ? String(term.parent_id) : NO_PARENT)
  const [saving, setSaving] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [slugError, setSlugError] = useState<string | null>(null)
  const [parentError, setParentError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const clearErrors = () => {
    setNameError(null)
    setSlugError(null)
    setParentError(null)
    setFormError(null)
  }

  const reset = () => {
    setName(term?.name ?? "")
    setSlug(term?.slug ?? "")
    setDescription(term?.description ?? "")
    setParentId(term?.parent_id ? String(term.parent_id) : NO_PARENT)
    clearErrors()
  }

  const choices = termParentOptions(type, terms, term?.id)
  const options = [
    { value: NO_PARENT, label: "None (top level)" },
    ...choices.map(({ term: t, depth }) => ({
      value: String(t.id),
      label: `${"— ".repeat(depth)}${t.name}`,
    })),
  ]
  // A saved parent the rules no longer offer (old data) stays listed, so the field
  // doesn't show an empty value.
  const currentParent = term?.parent_id ? terms.find((t) => t.id === term.parent_id) : undefined
  if (currentParent && !options.some((o) => o.value === String(currentParent.id))) {
    options.push({ value: String(currentParent.id), label: currentParent.name })
  }
  const parentLocked = nestsOneLevel(type) && choices.length === 0 && !currentParent

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim().length < 2) {
      setNameError("The name needs at least 2 characters.")
      return
    }
    setSaving(true)
    clearErrors()
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
      const { field, message } = termErrorMessage(error, "save")
      if (field === "slug") setSlugError(message)
      else if (field === "parent") setParentError(message)
      else setFormError(message)
    } finally {
      setSaving(false)
    }
  }

  const cancel = () => {
    reset()
    onCancel()
  }

  const key = term?.id ?? "new"
  const titleId = `gl-term-form-title-${key}`
  const slugId = `term-slug-${key}`
  const prefix = slugPrefix(type, structure)
  const hint = slugHint(type, term, slug, name, structure)
  const noun = singular(type)
  const canDelete = Boolean(term && onDelete && !isDefaultTerm(type, term))

  return (
    <form className="gl-workspace__panel gl-term-form" onSubmit={handleSubmit} noValidate aria-labelledby={titleId}>
      <h2 id={titleId}>{term ? `Edit “${term.name}”` : `New ${noun}`}</h2>
      <Input
        title="Name"
        name="term-name"
        id={`term-name-${key}`}
        value={name}
        error={nameError}
        onChange={(e) => setName(e.target.value)}
      />
      {/* The address prefix sits inside the control, before the input, as on the board. */}
      <div className={`gl-input gl-slug-field${slugError ? " is-invalid" : ""}`}>
        <label className="gl-input__label" htmlFor={slugId}>
          Slug
        </label>
        <div className="gl-slug-field__control">
          {prefix && (
            <span className="gl-slug-field__prefix" id={`${slugId}-prefix`}>
              {prefix}
            </span>
          )}
          <input
            id={slugId}
            name="term-slug"
            type="text"
            className="gl-slug-field__input"
            value={slug}
            spellCheck={false}
            autoCapitalize="off"
            aria-invalid={slugError ? true : undefined}
            aria-describedby={describedBy(slugId, hint, slugError, prefix ? `${slugId}-prefix` : undefined)}
            onChange={(e) => setSlug(e.target.value)}
          />
        </div>
        <FieldMessage id={slugId} hint={hint} error={slugError} />
      </div>
      {type.hierarchical && (
        <Select
          label="Parent"
          options={options}
          value={parentId}
          onChange={(value) => {
            setParentId(value)
            setParentError(null)
          }}
          disabled={parentLocked}
          hint={parentHint(type, terms, term)}
          error={parentError}
        />
      )}
      <Textarea
        label="Description"
        id={`term-description-${key}`}
        rows={3}
        optional
        hint={`Shown on the ${noun} page if your theme supports it.`}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      {formError && (
        <Notice tone="danger" live="alert">
          {formError}
        </Notice>
      )}
      <div className="gl-workspace__panel-actions">
        {canDelete && (
          <Button variant="ghost" className="gl-button--danger-text" onClick={() => term && onDelete?.(term)} disabled={saving}>
            Delete
          </Button>
        )}
        <span className="gl-workspace__spacer" />
        <Button variant="secondary" onClick={cancel} disabled={saving}>
          {term ? "Cancel" : "Clear"}
        </Button>
        <Button variant="primary" type="submit" loading={saving}>
          {term ? "Save" : `Add ${noun}`}
        </Button>
      </div>
    </form>
  )
}

export { singular }
