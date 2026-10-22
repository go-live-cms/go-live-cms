import React, { useCallback, useEffect, useRef, useState } from "react"
import type { TaxonomyTerm, TaxonomyType } from "@gl-admin/lib/api/types"
import {
  addPostTaxonomyTerm,
  createTaxonomyTerm,
  getAllTaxonomyTerms,
  getPostTaxonomyTerms,
  getTaxonomyTermBySlug,
  getTaxonomyTypes,
  removePostTaxonomyTerm,
  searchTaxonomyTerms,
} from "@gl-admin/lib/api/taxonomies"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import { findTermByName, flattenTermTree, parseTagNames, slugify } from "@gl-admin/lib/taxonomy/terms"
import Button from "@gl-admin/components/ui/Button"

interface PostTaxonomiesProps {
  postId: number
  readOnly: boolean
}

const SUGGESTION_LIMIT = 10

// Finds the flat-type term called `name`, or creates it. Slugs are unique across
// all taxonomies, so a tag named like an existing category ("News") gets a
// type-suffixed slug ("news-tag") instead of failing.
async function findOrCreateTerm(type: TaxonomyType, name: string): Promise<TaxonomyTerm> {
  const { data } = await searchTaxonomyTerms({ type: type.name, q: name, limit: 20 })
  const existing = findTermByName(data, name)
  if (existing) return existing
  try {
    return (await createTaxonomyTerm({ name, taxonomy_type_id: type.id })).taxonomy_term
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "slug_taken")) throw error
    // The search is a capped substring match, so the term may exist after all
    const { taxonomy_term: taken } = await getTaxonomyTermBySlug(slugify(name))
    if (taken.taxonomy_type_id === type.id) return taken
    const slug = slugify(`${slugify(name)}-${type.name}`)
    return (await createTaxonomyTerm({ name, slug, taxonomy_type_id: type.id })).taxonomy_term
  }
}

// Categories and tags of a post (#167): a checkbox tree for hierarchical types,
// a tag input for flat ones. Each change adds or removes one term at once
// (PUT/DELETE /posts/:id/taxonomy-terms/:term_id), independent of the editor's
// block autosave, so editors changing different terms don't overwrite each
// other. Read-only users see the assigned terms but can't change them.
export default function PostTaxonomies({ postId, readOnly }: PostTaxonomiesProps) {
  const [types, setTypes] = useState<TaxonomyType[]>([])
  // Every term of the hierarchical types (the tree needs them all). Flat types
  // can have thousands of terms, so they only get search suggestions.
  const [treeTerms, setTreeTerms] = useState<Record<string, TaxonomyTerm[]>>({})
  const [suggestions, setSuggestions] = useState<Record<string, TaxonomyTerm[]>>({})
  const [assigned, setAssigned] = useState<TaxonomyTerm[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [tagInputs, setTagInputs] = useState<Record<string, string>>({})
  // Latest suggestion query per type, so a slow earlier response can't win
  const latestQuery = useRef<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [{ data }, postTerms] = await Promise.all([getTaxonomyTypes(), getPostTaxonomyTerms(postId)])
      const shown = data.filter((t) => t.show_ui)
      const hierarchical = shown.filter((t) => t.hierarchical)
      const lists = await Promise.all(hierarchical.map((t) => getAllTaxonomyTerms(t.name)))
      setTypes(shown)
      setTreeTerms(Object.fromEntries(hierarchical.map((t, i) => [t.name, lists[i]])))
      setAssigned(postTerms)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [postId])

  useEffect(() => {
    load()
  }, [load])

  const isAssigned = (id: number) => assigned.some((t) => t.id === id)

  // Optimistic: show the change at once, undo just that term if saving fails.
  const setTerm = async (term: TaxonomyTerm, on: boolean) => {
    const without = (list: TaxonomyTerm[]) => list.filter((t) => t.id !== term.id)
    setAssigned((prev) => (on ? [...without(prev), term] : without(prev)))
    setSaving(true)
    setSaveError(null)
    try {
      await (on ? addPostTaxonomyTerm(postId, term.id) : removePostTaxonomyTerm(postId, term.id))
    } catch (error) {
      setAssigned((prev) => (on ? without(prev) : [...without(prev), term]))
      setSaveError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const suggest = async (type: TaxonomyType, input: string) => {
    const q = input.split(",").pop()?.trim() ?? ""
    latestQuery.current[type.name] = q
    if (!q) {
      setSuggestions((prev) => ({ ...prev, [type.name]: [] }))
      return
    }
    try {
      const { data } = await searchTaxonomyTerms({ type: type.name, q, limit: SUGGESTION_LIMIT })
      if (latestQuery.current[type.name] === q) setSuggestions((prev) => ({ ...prev, [type.name]: data }))
    } catch {
      // Suggestions are optional; typing a name still works
    }
  }

  // Each tag is found or created and then assigned before the next one, so a
  // failure part way keeps what was done and leaves the rest in the input.
  const addTags = async (type: TaxonomyType) => {
    const names = parseTagNames(tagInputs[type.name] ?? "")
    if (names.length === 0) return
    setSaving(true)
    setSaveError(null)
    const ofType = assigned.filter((t) => t.taxonomy_type_id === type.id)
    let done = 0
    try {
      for (const name of names) {
        const term = findTermByName(ofType, name) ?? (await findOrCreateTerm(type, name))
        if (!isAssigned(term.id)) {
          await addPostTaxonomyTerm(postId, term.id)
          setAssigned((prev) => [...prev.filter((t) => t.id !== term.id), term])
        }
        done++
      }
    } catch (error) {
      setSaveError(errorMessage(error))
    } finally {
      setTagInputs((prev) => ({ ...prev, [type.name]: names.slice(done).join(", ") }))
      setSuggestions((prev) => ({ ...prev, [type.name]: [] }))
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
        const inputId = `post-terms-${type.name}`

        if (type.hierarchical) {
          const terms = treeTerms[type.name] ?? []
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
                          checked={isAssigned(term.id)}
                          disabled={disabled}
                          onChange={(e) => setTerm(term, e.target.checked)}
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

        const selected = assigned.filter((t) => t.taxonomy_type_id === type.id)
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
                        onClick={() => setTerm(term, false)}
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
                  onChange={(e) => {
                    setTagInputs((prev) => ({ ...prev, [type.name]: e.target.value }))
                    suggest(type, e.target.value)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      addTags(type)
                    }
                  }}
                />
                <datalist id={`${inputId}-options`}>
                  {(suggestions[type.name] ?? [])
                    .filter((t) => !isAssigned(t.id))
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
