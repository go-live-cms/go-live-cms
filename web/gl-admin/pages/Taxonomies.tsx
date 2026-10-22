import React, { useCallback, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import Listing from "@gl-admin/layouts/Listing"
import Button from "@gl-admin/components/ui/Button"
import Icon from "@gl-admin/components/ui/Icon"
import FilterSelect from "@gl-admin/components/ui/FilterSelect"
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import TermFormModal from "@gl-admin/components/taxonomies/TermFormModal"
import DeleteTermModal from "@gl-admin/components/taxonomies/DeleteTermModal"
import { getAllTaxonomyTerms, getTaxonomyTypes } from "@gl-admin/lib/api/taxonomies"
import type { TaxonomyTerm, TaxonomyType } from "@gl-admin/lib/api/types"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { canEditContent } from "@gl-admin/lib/roles"
import { useCurrentRole } from "@gl-admin/lib/hooks/useCurrentRole"
import { childCount, flattenTermTree } from "@gl-admin/lib/taxonomy/terms"
import "@gl-admin/assets/styles/pages/taxonomies.scss"

type TermRow = TaxonomyTerm & { depth: number; parent_name: string; actions?: null }

// Categories, tags and other taxonomy types with their terms (#167). Everyone
// with admin access can look; only editors and admins can change terms
// (requireContentEditor in the API).
const Taxonomies: React.FC = () => {
  const { baseTitle } = useGoLive()
  const canEdit = canEditContent(useCurrentRole())
  const [searchParams, setSearchParams] = useSearchParams()

  const [types, setTypes] = useState<TaxonomyType[]>([])
  const [typesLoading, setTypesLoading] = useState(true)
  const [typesError, setTypesError] = useState<unknown>(null)

  const [terms, setTerms] = useState<TaxonomyTerm[]>([])
  const [termsLoading, setTermsLoading] = useState(false)
  const [termsError, setTermsError] = useState<unknown>(null)

  const [editing, setEditing] = useState<TaxonomyTerm | undefined>()
  const [formOpen, setFormOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const visibleTypes = useMemo(() => types.filter((t) => t.show_ui), [types])
  const selectedType = visibleTypes.find((t) => t.name === searchParams.get("type")) ?? visibleTypes[0]

  useEffect(() => {
    document.title = `${baseTitle} Taxonomies`
  }, [])

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

  const loadTerms = useCallback(async (typeName: string) => {
    setTermsLoading(true)
    setTermsError(null)
    try {
      setTerms(await getAllTaxonomyTerms(typeName))
    } catch (error) {
      setTermsError(error)
    } finally {
      setTermsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTypes()
  }, [loadTypes])

  useEffect(() => {
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

  const deletingTerm = terms.find((t) => t.id === deletingId) ?? null

  const openCreate = () => {
    setEditing(undefined)
    setFormOpen(true)
  }
  const openEdit = (term: TaxonomyTerm) => {
    setEditing(term)
    setFormOpen(true)
  }
  const reloadTerms = () => selectedType && loadTerms(selectedType.name)

  const columns: TableColumnWithRender<TermRow>[] = [
    {
      key: "name",
      name: "Name",
      width: "16rem",
      render: (_, row) =>
        row ? (
          <span className="gl-taxonomies__term-name">
            {row.depth > 0 && <span className="gl-taxonomies__term-depth">{"— ".repeat(row.depth)}</span>}
            {row.name}
          </span>
        ) : (
          <div className="skeleton">&nbsp;</div>
        ),
    },
    { key: "slug", name: "Slug", width: "12rem" },
    ...(selectedType?.hierarchical
      ? [
          {
            key: "parent_name",
            name: "Parent",
            width: "12rem",
            render: (_: unknown, row: TermRow | null) =>
              row ? row.parent_name || <span className="gl-taxonomies__muted">—</span> : <div className="skeleton">&nbsp;</div>,
          } as TableColumnWithRender<TermRow>,
        ]
      : []),
    {
      key: "post_count",
      name: "Posts",
      width: "6rem",
      render: (_, row) => (row ? String(row.post_count ?? 0) : <div className="skeleton">&nbsp;</div>),
    },
    ...(canEdit
      ? [
          {
            key: "actions",
            name: "",
            width: "10rem",
            render: (_: unknown, row: TermRow | null) =>
              row && (
                <div className="gl-taxonomies__row-actions">
                  <Button variation="flat" onClick={() => openEdit(row)} aria-label={`Edit ${row.name}`}>
                    Edit
                  </Button>
                  <Button variation="danger" onClick={() => setDeletingId(row.id)} aria-label={`Delete ${row.name}`}>
                    Delete
                  </Button>
                </div>
              ),
          } as TableColumnWithRender<TermRow>,
        ]
      : []),
  ]

  const actions = selectedType && (
    <>
      {visibleTypes.length > 1 && (
        <FilterSelect
          value={selectedType.name}
          options={visibleTypes.map((t) => ({ label: t.label, value: t.name }))}
          prefix="Taxonomy:"
          onChange={(value) => setSearchParams({ type: value })}
        />
      )}
      {canEdit && (
        <Button onClick={openCreate} className="gl-admin-media__new-media-btn">
          <Icon name="add" color="#000000" width="14" height="14" /> New term
        </Button>
      )}
    </>
  )

  const renderContent = () => {
    if (typesError) {
      return (
        <EmptyState
          variant="error"
          icon="close"
          title="Couldn't load taxonomies"
          description={errorMessage(typesError)}
          action={
            <Button variation="primary" onClick={loadTypes}>
              Try again
            </Button>
          }
        />
      )
    }
    if (!typesLoading && !selectedType) {
      return (
        <EmptyState
          icon="content"
          title="No taxonomies yet"
          description="Taxonomy types such as categories and tags will show up here."
        />
      )
    }
    if (termsError) {
      return (
        <EmptyState
          variant="error"
          icon="close"
          title={`Couldn't load ${selectedType?.label.toLowerCase() ?? "terms"}`}
          description={errorMessage(termsError)}
          action={
            <Button variation="primary" onClick={reloadTerms}>
              Try again
            </Button>
          }
        />
      )
    }
    const loading = typesLoading || termsLoading
    if (!loading && selectedType && terms.length === 0) {
      return (
        <EmptyState
          icon="content"
          title={`No ${selectedType.label.toLowerCase()} yet`}
          description={
            canEdit
              ? `Create the first term, then assign it to posts from the post settings sidebar.`
              : `Editors and administrators can add terms here.`
          }
          action={
            canEdit && (
              <Button variation="primary" onClick={openCreate}>
                <Icon name="add" color="white" width="14" height="14" /> New term
              </Button>
            )
          }
        />
      )
    }
    return (
      <Table<TermRow> columns={columns} data={rows} loading={loading} onRowDoubleClick={canEdit ? openEdit : undefined} />
    )
  }

  return (
    <Listing title="Taxonomies" actions={actions}>
      {selectedType?.description && <p className="gl-taxonomies__intro">{selectedType.description}</p>}
      {!canEdit && (
        <p className="gl-taxonomies__notice" role="status">
          View-only: only editors and administrators can change taxonomies.
        </p>
      )}
      {renderContent()}

      {selectedType && canEdit && (
        <TermFormModal
          isOpen={formOpen}
          type={selectedType}
          terms={terms}
          term={editing}
          onClose={() => setFormOpen(false)}
          onSaved={() => {
            setFormOpen(false)
            reloadTerms()
          }}
        />
      )}
      {canEdit && (
        <DeleteTermModal
          term={deletingTerm}
          childCount={deletingTerm ? childCount(terms, deletingTerm.id) : 0}
          onClose={() => setDeletingId(null)}
          onDeleted={() => {
            setDeletingId(null)
            reloadTerms()
          }}
          onStale={reloadTerms}
        />
      )}
    </Listing>
  )
}

export default Taxonomies
