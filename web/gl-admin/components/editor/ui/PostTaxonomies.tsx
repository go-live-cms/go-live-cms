import React, { useCallback, useEffect, useState } from "react"
import type { TaxonomyTerm, TaxonomyType } from "@gl-admin/lib/api/types"
import {
  createTaxonomyTerm,
  getAllTaxonomyTerms,
  getPostTaxonomyTerms,
  getTaxonomyTypes,
  setPostTaxonomyTerms,
} from "@gl-admin/lib/api/taxonomies"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { findTermByName, flattenTermTree, parseTagNames, toggleId } from "@gl-admin/lib/taxonomy/terms"
import Button from "@gl-admin/components/ui/Button"

interface PostTaxonomiesProps {
  postId: number
  readOnly: boolean
}

// Categories and tags of a post (#167): a checkbox tree for hierarchical types,
// a tag input for flat ones. Each change saves at once through PUT /posts/:id
// (taxonomy_ids), independent of the editor's block autosave. Read-only users
// see the assigned terms but can't change them.
export default function PostTaxonomies({ postId, readOnly }: PostTaxonomiesProps) {
  const [types, setTypes] = useState<TaxonomyType[]>([])
  const [termsByType, setTermsByType] = useState<Record<string, TaxonomyTerm[]>>({})
  const [assigned, setAssigned] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [tagInputs, setTagInputs] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [{ data }, postTerms] = await Promise.all([getTaxonomyTypes(), getPostTaxonomyTerms(postId)])
      const shown = data.filter((t) => t.show_ui)
      const lists = await Promise.all(shown.map((t) => getAllTaxonomyTerms(t.name)))
      setTypes(shown)
      setTermsByType(Object.fromEntries(shown.map((t, i) => [t.name, lists[i]])))
      setAssigned(postTerms.map((t) => t.id))
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [postId])

  useEffect(() => {
    load()
  }, [load])

  // Optimistic: show the new set at once, put the old one back if saving fails.
  const save = async (next: number[]) => {
    const previous = assigned
    setAssigned(next)
    setSaving(true)
    setSaveError(null)
    try {
      await setPostTaxonomyTerms(postId, next)
    } catch (error) {
      setAssigned(previous)
      setSaveError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const addTags = async (type: TaxonomyType) => {
    const names = parseTagNames(tagInputs[type.name] ?? "")
    if (names.length === 0) return
    const known = termsByType[type.name] ?? []
    setSaving(true)
    setSaveError(null)
    try {
      const ids: number[] = []
      const created: TaxonomyTerm[] = []
      for (const name of names) {
        const existing = findTermByName([...known, ...created], name)
        if (existing) {
          ids.push(existing.id)
        } else {
          const { taxonomy_term } = await createTaxonomyTerm({ name, taxonomy_type_id: type.id })
          created.push(taxonomy_term)
          ids.push(taxonomy_term.id)
        }
      }
      if (created.length > 0) setTermsByType((prev) => ({ ...prev, [type.name]: [...known, ...created] }))
      setTagInputs((prev) => ({ ...prev, [type.name]: "" }))
      await save([...assigned.filter((id) => !ids.includes(id)), ...ids])
    } catch (error) {
      setSaveError(errorMessage(error))
      setSaving(false)
    }
  }

  if (loading) {
    return <small className="post-settings__field-description">Loading categories and tags…</small>
  }
  if (loadError) {
    return (
      <div className="post-settings__field">
        <small className="post-settings__field-error">Couldn't load taxonomies: {loadError}</small>
        <Button variation="flat" onClick={load}>
          Try again
        </Button>
      </div>
    )
  }
  if (types.length === 0) {
    return <small className="post-settings__field-description">No taxonomies are set up.</small>
  }

  const disabled = readOnly || saving

  return (
    <>
      {types.map((type) => {
        const terms = termsByType[type.name] ?? []
        const inputId = `post-terms-${type.name}`

        if (type.hierarchical) {
          return (
            <div className="post-settings__field" key={type.name}>
              <label>{type.label}</label>
              {terms.length === 0 ? (
                <small className="post-settings__field-description">
                  None yet. Add them under <a href="/gl-admin/taxonomies">Taxonomies</a>.
                </small>
              ) : (
                <ul className="post-settings__term-tree" aria-label={type.label}>
                  {flattenTermTree(terms).map(({ term, depth }) => (
                    <li key={term.id} style={{ paddingLeft: `${depth * 1.25}rem` }}>
                      <label className="post-settings__checkbox">
                        <input
                          type="checkbox"
                          checked={assigned.includes(term.id)}
                          disabled={disabled}
                          onChange={(e) => save(toggleId(assigned, term.id, e.target.checked))}
                        />
                        {term.name}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        }

        const selected = terms.filter((t) => assigned.includes(t.id))
        return (
          <div className="post-settings__field" key={type.name}>
            <label htmlFor={inputId}>{type.label}</label>
            {selected.length > 0 && (
              <ul className="post-settings__tags" aria-label={`Assigned ${type.label.toLowerCase()}`}>
                {selected.map((term) => (
                  <li key={term.id} className="post-settings__tag">
                    {term.name}
                    {!readOnly && (
                      <button
                        type="button"
                        className="post-settings__tag-remove"
                        aria-label={`Remove ${term.name}`}
                        disabled={disabled}
                        onClick={() => save(toggleId(assigned, term.id, false))}
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && (
              <>
                <input
                  type="text"
                  id={inputId}
                  list={`${inputId}-options`}
                  placeholder="Add, separated by commas"
                  value={tagInputs[type.name] ?? ""}
                  disabled={disabled}
                  onChange={(e) => setTagInputs((prev) => ({ ...prev, [type.name]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      addTags(type)
                    }
                  }}
                />
                <datalist id={`${inputId}-options`}>
                  {terms
                    .filter((t) => !assigned.includes(t.id))
                    .map((t) => (
                      <option key={t.id} value={t.name} />
                    ))}
                </datalist>
                <small className="post-settings__field-description">
                  Press Enter to add. New {type.label.toLowerCase()} are created for you.
                </small>
              </>
            )}
            {readOnly && selected.length === 0 && <small className="post-settings__field-description">None</small>}
          </div>
        )
      })}
      {saving && <small className="post-settings__field-description" role="status">Saving…</small>}
      {saveError && (
        <small className="post-settings__field-error" role="alert">
          Couldn't save: {saveError}
        </small>
      )}
    </>
  )
}
