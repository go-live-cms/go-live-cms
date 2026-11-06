import React, { useState } from "react"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import { Select } from "@gl-admin/components/ui/Select"
import type { TaxonomyTerm, TaxonomyType } from "@gl-admin/lib/api/types"
import { mergeTaxonomyTerms, type MergeTermsResult } from "@gl-admin/lib/api/taxonomies"
import { defaultKeep, mergeSummary, termErrorMessage } from "@gl-admin/lib/taxonomyAdmin"
import { plural } from "@gl-admin/utils/formatting"

interface MergeTagsPanelProps {
  type: TaxonomyType
  // The selected terms, two or more.
  terms: TaxonomyTerm[]
  noun: string
  nouns: string
  onCancel: () => void
  onMerged: (result: MergeTermsResult, keep: TaxonomyTerm) => void
}

// The side panel for merging the selected tags (#331, the "Taxonomies · tags" board):
// chips of the selected tags, which one to keep, and what the merge does. The API moves
// the others' posts to the kept tag, deletes them and redirects their pages.
export default function MergeTagsPanel({ type, terms, noun, nouns, onCancel, onMerged }: MergeTagsPanelProps) {
  const [keepId, setKeepId] = useState(() => String(defaultKeep(terms)?.id ?? ""))
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The selection can change while the panel is open: fall back to the default pick.
  const keep = terms.find((t) => String(t.id) === keepId) ?? defaultKeep(terms)
  const sources = terms.filter((t) => t.id !== keep?.id)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!keep || sources.length === 0) return
    setMerging(true)
    setError(null)
    try {
      const result = await mergeTaxonomyTerms(
        keep.id,
        sources.map((t) => t.id)
      )
      onMerged(result, keep)
    } catch (err) {
      setError(termErrorMessage(err, "merge").message)
    } finally {
      setMerging(false)
    }
  }

  const titleId = "gl-merge-terms-title"
  const summaryId = "gl-merge-terms-summary"

  return (
    <form className="gl-workspace__panel gl-merge-panel" onSubmit={handleSubmit} noValidate aria-labelledby={titleId}>
      <h2 id={titleId}>Merge {plural(terms.length, noun, nouns)}</h2>
      <ul className="gl-merge-panel__chips" aria-label={`Selected ${nouns}`}>
        {terms.map((t) => (
          <li key={t.id} className="gl-merge-panel__chip">
            {t.name}
          </li>
        ))}
      </ul>
      <Select
        label="Keep"
        options={terms.map((t) => ({ value: String(t.id), label: t.name }))}
        value={keep ? String(keep.id) : ""}
        onChange={(value) => {
          setKeepId(value)
          setError(null)
        }}
      />
      {keep && (
        <p className="gl-merge-panel__summary" id={summaryId} aria-live="polite">
          {mergeSummary(type, keep, sources)}
        </p>
      )}
      {error && (
        <Notice tone="danger" live="alert">
          {error}
        </Notice>
      )}
      <div className="gl-workspace__panel-actions">
        <span className="gl-workspace__spacer" />
        <Button variant="secondary" onClick={onCancel} disabled={merging}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" loading={merging} disabled={!keep || sources.length === 0} aria-describedby={keep ? summaryId : undefined}>
          Merge {nouns}
        </Button>
      </div>
    </form>
  )
}
