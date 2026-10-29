import React, { useCallback, useEffect, useState } from "react"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import Button from "@gl-admin/components/ui/Button"
import Input from "@gl-admin/components/ui/Input"
import Checkbox from "@gl-admin/components/ui/Checkbox"
import Notice from "@gl-admin/components/ui/Notice"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import { toast } from "@gl-admin/components/ui/Toast"
import { PlusIcon } from "@gl-admin/components/ui/icons"
import { createPostType, getPostTypes, updatePostType } from "@gl-admin/lib/api/postTypes"
import type { PostType } from "@gl-admin/lib/api/types"
import { errorMessage } from "@gl-admin/lib/api/errors"
import {
  SUPPORT_FIELDS,
  draftFromPostType,
  isBuiltInPostType,
  nameFromLabel,
  newPostTypeDraft,
  postTypeInput,
  supportsSummary,
  validatePostTypeDraft,
  type PostTypeDraft,
} from "@gl-admin/lib/postTypes"
import "@gl-admin/assets/styles/pages/workspace.scss"

// Post types (#343, the Post types board): the list, and a panel beside it that
// creates a type or edits one. Admin only (requireSiteAdmin on POST and PUT).
// Posts and Pages are built in: the API refuses changes to them, so they only list.
//
// Not here: an icon picker (the API accepts `icon` on create but doesn't store it, and
// PUT refuses it), the item counts (no endpoint counts every type at once), separate
// singular and plural labels (a type has one label) and deleting a type (no endpoint).

type Row = PostType & { fields?: null }

export default function PostTypes() {
  const { baseTitle } = useGoLive()
  const [types, setTypes] = useState<PostType[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)
  // null: the panel is closed; "new": creating; otherwise the name being edited.
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    document.title = `${baseTitle} Post types`
  }, [])

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      setTypes((await getPostTypes()).data)
    } catch (error) {
      setLoadError(error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const editing = open && open !== "new" ? types.find((t) => t.name === open) : undefined

  const columns: TableColumnWithRender<Row>[] = [
    {
      key: "label",
      name: "Label",
      render: (_, row) =>
        row ? (
          <span className="gl-post-type-label">
            {isBuiltInPostType(row.name) ? (
              <span className="gl-post-type-label__text">{row.label}</span>
            ) : (
              <button
                type="button"
                className="gl-row-link"
                aria-label={`Edit ${row.label}`}
                aria-current={row.name === open ? "true" : undefined}
                onClick={() => setOpen(row.name)}
              >
                {row.label}
              </button>
            )}
            {isBuiltInPostType(row.name) && <span className="gl-workspace__badge">Built-in</span>}
          </span>
        ) : (
          <Skeleton shape="text" width={120} />
        ),
    },
    {
      key: "name",
      name: "Name",
      width: "12rem",
      render: (_, row) => (row ? <span className="gl-workspace__mono">{row.name}</span> : <Skeleton shape="text" width={80} />),
    },
    {
      key: "fields",
      name: "Fields on",
      width: "7rem",
      render: (_, row) =>
        row ? <span className="gl-workspace__muted">{supportsSummary(row.supports)}</span> : <Skeleton shape="text" width={40} />,
    },
  ]

  const renderList = () => {
    if (loadError) {
      return (
        <EmptyState
          variant="error"
          icon="close"
          title="Couldn't load post types"
          description={errorMessage(loadError)}
          action={
            <Button variant="primary" onClick={load}>
              Try again
            </Button>
          }
        />
      )
    }
    return (
      <Table<Row>
        columns={columns}
        data={types}
        loading={loading}
        aria-label="Post types"
        rowKey={(row) => row.name}
        rowClassName={(row) => (row.name === open ? "is-current" : undefined)}
        onRowDoubleClick={(row) => !isBuiltInPostType(row.name) && setOpen(row.name)}
      />
    )
  }

  return (
    <div className="gl-workspace gl-post-types">
      <header className="gl-workspace__header">
        <div className="gl-workspace__heading">
          <h1>Post types</h1>
          <span className="gl-workspace__subtitle">Each type gets its own list in the sidebar.</span>
        </div>
        <div className="gl-workspace__actions">
          <Button variant="primary" icon={<PlusIcon />} onClick={() => setOpen("new")}>
            New post type
          </Button>
        </div>
      </header>

      <div className="gl-workspace__split">
        <div className="gl-workspace__main">{renderList()}</div>
        {(open === "new" || editing) && (
          <PostTypeForm
            key={editing?.name ?? "new"}
            postType={editing}
            onCancel={() => setOpen(null)}
            onSaved={(saved) => {
              setOpen(saved.name)
              load()
            }}
          />
        )}
      </div>
    </div>
  )
}

type FormProps = {
  // The type being edited; undefined creates one.
  postType?: PostType
  onCancel: () => void
  onSaved: (postType: PostType) => void
}

function PostTypeForm({ postType, onCancel, onSaved }: FormProps) {
  const creating = !postType
  const [draft, setDraft] = useState<PostTypeDraft>(() => (postType ? draftFromPostType(postType) : newPostTypeDraft()))
  // Until the name is typed, it follows the label.
  const [nameTouched, setNameTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const set = (patch: Partial<PostTypeDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }))
    setError(null)
  }

  const toggleField = (value: string, on: boolean) =>
    set({ supports: on ? [...draft.supports, value] : draft.supports.filter((s) => s !== value) })

  // Fields a theme registered that the form doesn't know; kept and shown as they are.
  const otherFields = draft.supports.filter((s) => !SUPPORT_FIELDS.some((f) => f.value === s))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const invalid = validatePostTypeDraft(draft, creating)
    if (invalid) {
      setError(invalid)
      return
    }
    setSaving(true)
    try {
      const input = postTypeInput(draft, postType)
      const { post_type } = creating ? await createPostType({ ...input, name: draft.name }) : await updatePostType(postType.name, input)
      toast.success(creating ? `${post_type.label} created` : `${post_type.label} saved`)
      onSaved(post_type)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="gl-workspace__panel" onSubmit={submit} noValidate aria-labelledby="gl-post-type-form-title">
      <h2 id="gl-post-type-form-title">{creating ? "New post type" : `Edit “${postType.label}”`}</h2>

      <Input
        title="Label"
        name="label"
        unmasked
        id="gl-post-type-label"
        placeholder="Case studies"
        hint="What people see in the sidebar and lists."
        value={draft.label}
        onChange={(e) => {
          const label = e.target.value
          set(creating && !nameTouched ? { label, name: nameFromLabel(label) } : { label })
        }}
      />

      {creating ? (
        <Input
          title="Name"
          name="name"
          id="gl-post-type-name"
          className="gl-post-types__name"
          placeholder="case_studies"
          hint="Lowercase letters, numbers, hyphens and underscores. Used in URLs, by themes and the API. It can't be changed later."
          value={draft.name}
          onChange={(e) => {
            setNameTouched(true)
            set({ name: e.target.value })
          }}
        />
      ) : (
        <div className="gl-workspace-field">
          <span className="gl-workspace-field__label">Name</span>
          <span className="gl-workspace__mono">{postType.name}</span>
        </div>
      )}

      <fieldset className="gl-post-types__group">
        <legend className="gl-workspace-field__label">Behaviour</legend>
        <Checkbox
          label="Public"
          description="Readers can open its items on the site."
          checked={draft.public}
          onChange={(on) => set({ public: on })}
        />
        <Checkbox
          label="Hierarchical"
          description="Items can have a parent, like pages."
          checked={draft.hierarchical}
          onChange={(on) => set({ hierarchical: on })}
        />
        <Checkbox
          label="Archive page"
          description="The site lists its items on one page."
          checked={draft.has_archive}
          onChange={(on) => set({ has_archive: on })}
        />
      </fieldset>

      <Input
        title="Menu position"
        type="number"
        name="menu_position"
        id="gl-post-type-position"
        optional
        inputMode="numeric"
        containerClassName="gl-post-types__position"
        hint="Lower numbers come first in the sidebar. Empty puts it last."
        value={draft.menu_position}
        onChange={(e) => set({ menu_position: e.target.value.trim() })}
      />

      <fieldset className="gl-post-types__group">
        <legend className="gl-workspace-field__label">Fields</legend>
        <div className="gl-post-types__fields">
          {SUPPORT_FIELDS.map((f) => (
            <Checkbox
              key={f.value}
              label={f.label}
              description={f.note}
              checked={draft.supports.includes(f.value)}
              onChange={(on) => toggleField(f.value, on)}
            />
          ))}
          {otherFields.map((value) => (
            <Checkbox key={value} label={value} description="Added by a theme" checked onChange={(on) => toggleField(value, on)} />
          ))}
        </div>
      </fieldset>

      {error && (
        <Notice tone="danger" live="alert">
          {error}
        </Notice>
      )}

      <div className="gl-workspace__panel-actions">
        <span className="gl-workspace__spacer" />
        <Button variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" loading={saving}>
          {creating ? "Create post type" : "Save"}
        </Button>
      </div>
    </form>
  )
}
