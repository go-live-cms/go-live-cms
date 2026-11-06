import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import Button, { IconButton } from "@gl-admin/components/ui/Button"
import Input from "@gl-admin/components/ui/Input"
import FilterSelect from "@gl-admin/components/ui/FilterSelect"
import Notice from "@gl-admin/components/ui/Notice"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import { toast } from "@gl-admin/components/ui/Toast"
import { CloseIcon, PlusIcon } from "@gl-admin/components/ui/icons"
import TermForm, { singular } from "@gl-admin/components/taxonomies/TermForm"
import DeleteTermModal from "@gl-admin/components/taxonomies/DeleteTermModal"
import MergeTagsPanel from "@gl-admin/components/taxonomies/MergeTagsPanel"
import { createTaxonomyTerm, getAllTaxonomyTerms, getTaxonomyTypes } from "@gl-admin/lib/api/taxonomies"
import type { TaxonomyTerm, TaxonomyType } from "@gl-admin/lib/api/types"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { isContentModerator } from "@gl-admin/lib/roles"
import { useCurrentRole } from "@gl-admin/lib/hooks/useCurrentRole"
import { useSiteSettings } from "@gl-admin/lib/hooks/useSiteSettings"
import { childCount, findTermByName, flattenTermTree } from "@gl-admin/lib/taxonomy/terms"
import { isCategoryType, isDefaultTerm, taxonomyIntro, termErrorMessage } from "@gl-admin/lib/taxonomyAdmin"
import { plural } from "@gl-admin/utils/formatting"
import "@gl-admin/assets/styles/pages/workspace.scss"
import "@gl-admin/assets/styles/pages/taxonomies.scss"

type TermRow = TaxonomyTerm & { depth: number; parent_name: string }

// Up to this many types switch with a segmented control, as on the board; a site with
// more gets a dropdown.
const SEGMENTED_MAX = 4

// "tags" from "Tags".
const pluralNoun = (type: TaxonomyType) => type.label.trim().toLowerCase() || type.name

// Categories, tags and other taxonomy types with their terms (#167, restyled in #343:
// the "Taxonomies · categories" and "· tags" boards). Everyone with admin access can
// look; only editors and admins can change terms (requireContentEditor in the API).
// Hierarchical types list their terms as a tree, children indented under their parent.
// Since #331: one category per post, categories nest one level and (under the category
// URL structure) start post URLs, the default category has a badge and no Delete, and
// flat types (tags) are selectable to merge or delete several at once.
const Taxonomies: React.FC = () => {
  const { baseTitle } = useGoLive()
  const canEdit = isContentModerator(useCurrentRole())
  const structure = useSiteSettings()?.post_url_structure
  const [searchParams, setSearchParams] = useSearchParams()

  const [types, setTypes] = useState<TaxonomyType[]>([])
  const [typesLoading, setTypesLoading] = useState(true)
  const [typesError, setTypesError] = useState<unknown>(null)

  const [terms, setTerms] = useState<TaxonomyTerm[]>([])
  const [termsLoading, setTermsLoading] = useState(false)
  const [termsError, setTermsError] = useState<unknown>(null)

  const [editingId, setEditingId] = useState<number | null>(null)
  // The terms the delete dialog is about: one from the panel, or the selected tags.
  const [deletingIds, setDeletingIds] = useState<number[]>([])
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [merging, setMerging] = useState(false)

  const visibleTypes = useMemo(() => types.filter((t) => t.show_ui), [types])
  const selectedType = visibleTypes.find((t) => t.name === searchParams.get("type")) ?? visibleTypes[0]

  useEffect(() => {
    document.title = `${baseTitle} ${selectedType?.label ?? "Taxonomies"}`
  }, [selectedType?.label])

  const loadTypes = useCallback(async () => {
    setTypesLoading(true)
    setTypesError(null)
    try {
      setTypes((await getTaxonomyTypes()).data)
    } catch (error) {
      setTypesError(error)
    } finally {
      setTypesLoading(false)
    }
  }, [])

  // Only the latest request may update the list: switching types quickly must
  // not let a slower response for the previous type land afterwards.
  const termsRequest = useRef(0)
  const loadTerms = useCallback(async (typeName: string) => {
    const request = ++termsRequest.current
    setTermsLoading(true)
    setTermsError(null)
    try {
      const result = await getAllTaxonomyTerms(typeName)
      if (request === termsRequest.current) {
        setTerms(result)
        // Deleted or merged terms leave the selection.
        const ids = new Set(result.map((t) => t.id))
        setSelectedIds((prev) => prev.filter((id) => ids.has(id)))
      }
    } catch (error) {
      if (request === termsRequest.current) setTermsError(error)
    } finally {
      if (request === termsRequest.current) setTermsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTypes()
  }, [loadTypes])

  useEffect(() => {
    setEditingId(null)
    setSelectedIds([])
    setMerging(false)
    if (selectedType) loadTerms(selectedType.name)
    else setTerms([])
  }, [selectedType?.name, loadTerms])

  const rows: TermRow[] = useMemo(() => {
    const names = new Map(terms.map((t) => [t.id, t.name]))
    return flattenTermTree(terms).map(({ term, depth }) => ({
      ...term,
      depth,
      parent_name: (term.parent_id && names.get(term.parent_id)) || "",
    }))
  }, [terms])

  const editingTerm = terms.find((t) => t.id === editingId)
  const deletingTerms = terms.filter((t) => deletingIds.includes(t.id))
  const selectedTerms = terms.filter((t) => selectedIds.includes(t.id))
  const reloadTerms = () => selectedType && loadTerms(selectedType.name)
  const defaultTerm = selectedType?.default_term_id ? terms.find((t) => t.id === selectedType.default_term_id) : undefined
  // Only flat types merge (the API refuses hierarchical ones).
  const selectable = canEdit && !!selectedType && !selectedType.hierarchical
  const showMerge = merging && selectable && selectedTerms.length >= 2

  const openEditor = (id: number) => {
    setMerging(false)
    setEditingId(id)
  }

  const columns: TableColumnWithRender<TermRow>[] = [
    {
      key: "name",
      name: selectedType && !selectedType.hierarchical ? singular(selectedType).replace(/^./, (c) => c.toUpperCase()) : "Name",
      render: (_, row) =>
        row ? (
          <span className="gl-term-name" data-depth={row.depth} style={{ "--depth": row.depth } as React.CSSProperties}>
            {row.depth > 0 && (
              <span className="gl-term-name__branch" aria-hidden="true">
                └
              </span>
            )}
            {canEdit ? (
              <button
                type="button"
                className="gl-row-link"
                aria-label={`Edit ${row.name}`}
                aria-current={row.id === editingId ? "true" : undefined}
                onClick={() => openEditor(row.id)}
              >
                {row.name}
              </button>
            ) : (
              <span className="gl-term-name__text">{row.name}</span>
            )}
            {row.parent_name && <span className="gl-workspace__sr">, in {row.parent_name}</span>}
            {selectedType && isDefaultTerm(selectedType, row) && <span className="gl-workspace__badge">Default</span>}
          </span>
        ) : (
          <Skeleton shape="text" width={140} />
        ),
    },
    {
      key: "slug",
      name: "Slug",
      width: "14rem",
      render: (_, row) => (row ? <span className="gl-workspace__mono">{row.slug}</span> : <Skeleton shape="text" width={100} />),
    },
    {
      key: "post_count",
      name: "Posts",
      width: "5rem",
      numeric: true,
      render: (_, row) =>
        row ? <span className="gl-workspace__muted">{String(row.post_count ?? 0)}</span> : <Skeleton shape="text" width={20} />,
    },
  ]

  const typeLabel = selectedType?.label ?? "Taxonomies"
  const noun = selectedType ? singular(selectedType) : "term"
  const nouns = selectedType ? pluralNoun(selectedType) : "terms"
  const loading = typesLoading || termsLoading

  const renderList = () => {
    if (termsError) {
      return (
        <EmptyState
          variant="error"
          icon="close"
          title={`Couldn't load ${typeLabel.toLowerCase()}`}
          description={errorMessage(termsError)}
          action={
            <Button variant="primary" onClick={reloadTerms}>
              Try again
            </Button>
          }
        />
      )
    }
    if (!loading && selectedType && terms.length === 0) {
      return (
        <EmptyState
          compact
          icon="content"
          title={`No ${typeLabel.toLowerCase()} yet`}
          description={
            canEdit
              ? `Add the first ${noun}, then assign it to posts from the post settings sidebar.`
              : `Editors and administrators can add ${typeLabel.toLowerCase()} here.`
          }
        />
      )
    }
    return (
      <Table<TermRow>
        columns={columns}
        data={rows}
        loading={loading}
        aria-label={typeLabel}
        rowClassName={(row) => (row.id === editingId ? "is-current" : undefined)}
        onRowDoubleClick={canEdit ? (row) => openEditor(row.id) : undefined}
        selectable={selectable}
        selectedKeys={selectedIds}
        onSelectionChange={(keys) => setSelectedIds(keys.map(Number))}
        rowLabel={(row) => row.name}
      />
    )
  }

  const renderBulkBar = () => {
    if (!selectable || selectedTerms.length === 0) return null
    return (
      <div role="region" aria-label="Bulk actions" className="gl-taxonomies__bulk">
        <span className="gl-taxonomies__bulk-count" aria-hidden="true">
          {selectedTerms.length} selected
        </span>
        <div className="gl-taxonomies__bulk-actions">
          {selectedTerms.length >= 2 && (
            <Button
              size="sm"
              variant="secondary"
              aria-pressed={showMerge}
              onClick={() => {
                setEditingId(null)
                setMerging(true)
              }}
            >
              Merge…
            </Button>
          )}
          <Button size="sm" variant="danger" onClick={() => setDeletingIds(selectedTerms.map((t) => t.id))}>
            Delete
          </Button>
        </div>
        <IconButton
          size="sm"
          variant="ghost"
          aria-label="Clear selection"
          icon={<CloseIcon />}
          onClick={() => {
            setSelectedIds([])
            setMerging(false)
          }}
        />
      </div>
    )
  }

  const renderPanel = () => {
    if (!canEdit || !selectedType) return null
    if (showMerge) {
      return (
        <MergeTagsPanel
          key={`merge-${selectedType.name}`}
          type={selectedType}
          terms={selectedTerms}
          noun={noun}
          nouns={nouns}
          onCancel={() => setMerging(false)}
          onMerged={(result, keep) => {
            toast.success(`Merged into “${result.taxonomy_term?.name ?? keep.name}”`)
            setMerging(false)
            setSelectedIds([])
            reloadTerms()
          }}
        />
      )
    }
    // Hierarchical types create in the panel (they need a parent); flat ones, like
    // tags, by name above the list, and open the panel only to edit.
    if (!selectedType.hierarchical && !editingTerm) return null
    return (
      <TermForm
        key={`${selectedType.name}-${editingTerm?.id ?? "new"}`}
        type={selectedType}
        terms={terms}
        term={editingTerm}
        structure={structure}
        onCancel={() => setEditingId(null)}
        onSaved={() => {
          setEditingId(null)
          reloadTerms()
        }}
        onDelete={(term) => setDeletingIds([term.id])}
      />
    )
  }

  const renderBody = () => {
    if (typesError) {
      return (
        <EmptyState
          variant="error"
          icon="close"
          title="Couldn't load taxonomies"
          description={errorMessage(typesError)}
          action={
            <Button variant="primary" onClick={loadTypes}>
              Try again
            </Button>
          }
        />
      )
    }
    if (!typesLoading && !selectedType) {
      return (
        <EmptyState icon="content" title="No taxonomies yet" description="Taxonomy types such as categories and tags will show up here." />
      )
    }

    const intro = selectedType ? taxonomyIntro(selectedType, structure) : ""
    return (
      <div className="gl-workspace__split">
        <div className="gl-workspace__main">
          {intro && <p className="gl-workspace__section-intro">{intro}</p>}
          {!canEdit && (
            <Notice tone="info" live="none">
              View only: editors and administrators can change {typeLabel.toLowerCase()}.
            </Notice>
          )}
          {canEdit && selectedType && !selectedType.hierarchical && (
            <QuickAdd type={selectedType} terms={terms} onAdded={reloadTerms} />
          )}
          {/* Always in the page, so the count is announced as it changes. */}
          {selectable && (
            <span className="gl-workspace__sr" aria-live="polite">
              {selectedTerms.length > 0 ? `${plural(selectedTerms.length, `${noun} selected`, `${nouns} selected`)}` : ""}
            </span>
          )}
          {renderBulkBar()}
          {renderList()}
          {canEdit && selectedType?.hierarchical && editingTerm && (
            <Button variant="ghost" icon={<PlusIcon />} className="gl-taxonomies__new" onClick={() => setEditingId(null)}>
              New {noun}
            </Button>
          )}
        </div>
        {renderPanel()}
      </div>
    )
  }

  return (
    <div className="gl-workspace gl-taxonomies">
      <header className="gl-workspace__header">
        <div className="gl-workspace__heading">
          {selectedType && <span className="gl-workspace__eyebrow">Taxonomies</span>}
          <h1>{typeLabel}</h1>
        </div>
        {visibleTypes.length > SEGMENTED_MAX && selectedType && (
          <FilterSelect
            value={selectedType.name}
            options={visibleTypes.map((t) => ({ label: t.label, value: t.name }))}
            prefix="Taxonomy:"
            onChange={(value) => setSearchParams({ type: value })}
          />
        )}
        {visibleTypes.length > 1 && visibleTypes.length <= SEGMENTED_MAX && (
          <nav aria-label="Taxonomies" className="gl-segmented">
            {visibleTypes.map((t) => (
              <Link
                key={t.name}
                to={`?type=${encodeURIComponent(t.name)}`}
                className="gl-segmented__item"
                aria-current={t.name === selectedType?.name ? "page" : undefined}
              >
                {t.label}
              </Link>
            ))}
          </nav>
        )}
      </header>

      {renderBody()}

      {canEdit && (
        <DeleteTermModal
          terms={deletingTerms}
          childCount={(id) => childCount(terms, id)}
          movesTo={selectedType && isCategoryType(selectedType) ? defaultTerm?.name : undefined}
          noun={noun}
          nouns={nouns}
          onClose={() => setDeletingIds([])}
          onDeleted={() => {
            const many = deletingIds.length > 1
            setDeletingIds([])
            setEditingId(null)
            if (many) toast.success(`${plural(deletingIds.length, noun, nouns)} deleted`)
            reloadTerms()
          }}
          onStale={reloadTerms}
        />
      )}
    </div>
  )
}

// "New tag name" + Add: a flat term from its name alone (the API derives the slug).
function QuickAdd({ type, terms, onAdded }: { type: TaxonomyType; terms: TaxonomyTerm[]; onAdded: () => void }) {
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const noun = singular(type)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length < 2) {
      setError("The name needs at least 2 characters.")
      return
    }
    if (findTermByName(terms, trimmed)) {
      setError(`There's already a ${noun} called “${trimmed}”.`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await createTaxonomyTerm({ name: trimmed, taxonomy_type_id: type.id })
      setName("")
      onAdded()
    } catch (err) {
      setError(termErrorMessage(err).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="gl-quick-add" onSubmit={submit} noValidate>
      <Input
        title={`New ${noun} name`}
        hideLabel
        name="quick-add"
        id="gl-quick-add"
        placeholder={`New ${noun} name`}
        value={name}
        error={error}
        containerClassName="gl-quick-add__field"
        onChange={(e) => {
          setName(e.target.value)
          setError(null)
        }}
      />
      <Button type="submit" variant="secondary" loading={saving}>
        Add {noun}
      </Button>
    </form>
  )
}

export default Taxonomies
