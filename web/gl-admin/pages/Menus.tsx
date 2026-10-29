import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import {
  createMenu,
  deleteMenu,
  getMenu,
  listMenus,
  saveMenuItems,
  updateMenu,
  type Menu as MenuData,
  type MenuLocation,
} from "@gl-admin/lib/api/menus"
import { getActiveTheme } from "@gl-admin/lib/api/themes"
import { getPosts } from "@gl-admin/lib/api/posts"
import { getPostTypes } from "@gl-admin/lib/api/postTypes"
import { getAllTaxonomyTerms, getTaxonomyTypes } from "@gl-admin/lib/api/taxonomies"
import type { Post, PostType, TaxonomyTerm, TaxonomyType } from "@gl-admin/lib/api/types"
import { errorMessage } from "@gl-admin/lib/api/errors"
import {
  MAX_MENU_ITEMS,
  availableMoves,
  canDrop,
  countItems,
  describePlace,
  draftFromApi,
  draftToRequest,
  isDirty,
  isValidMenuUrl,
  itemName,
  menuTreeReducer,
  newItemKey,
  type DropPosition,
  type MenuDraftItem,
} from "@gl-admin/lib/menuTree"
import { toast } from "@gl-admin/components/ui/Toast"
import Button, { IconButton } from "@gl-admin/components/ui/Button"
import Input from "@gl-admin/components/ui/Input"
import Select from "@gl-admin/components/ui/Select"
import Tabs from "@gl-admin/components/ui/Tabs"
import Modal from "@gl-admin/components/ui/Modal"
import Pill from "@gl-admin/components/ui/Pill"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import UnsavedChangesBar from "@gl-admin/components/ui/UnsavedChangesBar"
import Menu, { MenuItem } from "@gl-admin/components/ui/Menu"
import { MoreIcon, PencilIcon, PlusIcon, TrashIcon } from "@gl-admin/components/ui/icons"
import "@gl-admin/assets/styles/pages/workspace.scss"
import "@gl-admin/assets/styles/pages/menus.scss"

// Appearance › Menus (#347): build menus from posts, pages, terms, archives and custom
// links, reorder and nest them (drag and drop, or the row's Move menu from the
// keyboard), and assign them to the active theme's locations. Editors and admins
// (requireContentEditor). The tree is edited locally and saved whole; the rules are
// in lib/menuTree.ts.

const TYPE_LABELS: Record<MenuDraftItem["type"], string> = { post: "Post", term: "Term", archive: "Archive", custom: "Link" }
const STATUS_TEXT: Partial<Record<MenuDraftItem["status"], string>> = {
  unpublished: "Hidden until published",
  not_public: "Hidden: not public",
  missing: "Hidden: target gone",
}

const NO_MENU = ""

const MenusPage: React.FC = () => {
  const { baseTitle } = useGoLive()
  const [menus, setMenus] = useState<MenuData[]>([])
  const [locations, setLocations] = useState<MenuLocation[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [saved, setSaved] = useState<{ name: string; items: MenuDraftItem[] } | null>(null)
  const [name, setName] = useState("")
  const [items, dispatch] = useReducer(menuTreeReducer, [])
  const [loadingMenu, setLoadingMenu] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState("")

  const [creating, setCreating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pendingSwitch, setPendingSwitch] = useState<number | null>(null)

  const dirty = !!saved && (name.trim() !== saved.name || isDirty(saved.items, items))

  const loadList = useCallback(async () => {
    const [list, theme] = await Promise.all([listMenus(), getActiveTheme().catch(() => null)])
    setMenus(list)
    setLocations(((theme?.config as { menu_locations?: MenuLocation[] } | undefined)?.menu_locations) ?? [])
    return list
  }, [])

  const openMenu = useCallback(async (id: number) => {
    setSelectedId(id)
    setLoadingMenu(true)
    setSaveError(null)
    try {
      const menu = await getMenu(id)
      const draft = draftFromApi(menu.items)
      setSaved({ name: menu.name, items: draft })
      setName(menu.name)
      dispatch({ type: "reset", items: draft })
    } catch (error) {
      toast.error(`Couldn't open the menu. ${errorMessage(error)}`)
    } finally {
      setLoadingMenu(false)
    }
  }, [])

  const load = useCallback(async () => {
    try {
      setLoadError(null)
      const list = await loadList()
      if (list.length) await openMenu(list[0].id)
    } catch (error) {
      setLoadError(error)
    } finally {
      setLoading(false)
    }
  }, [loadList, openMenu])

  useEffect(() => {
    document.title = `${baseTitle} Menus`
    load()
  }, [baseTitle, load])

  const switchMenu = (id: number) => {
    if (id === selectedId) return
    if (dirty) setPendingSwitch(id)
    else openMenu(id)
  }

  const discard = () => {
    if (!saved) return
    setName(saved.name)
    dispatch({ type: "reset", items: saved.items })
    setSaveError(null)
  }

  const save = async () => {
    if (!saved || selectedId === null) return
    const trimmed = name.trim()
    if (!trimmed) {
      setSaveError("Give the menu a name.")
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const current = menus.find((m) => m.id === selectedId)
      if (trimmed !== saved.name) await updateMenu(selectedId, { name: trimmed, location: current?.location ?? "" })
      const menu = await saveMenuItems(selectedId, draftToRequest(items))
      const draft = draftFromApi(menu.items)
      setSaved({ name: menu.name, items: draft })
      setName(menu.name)
      dispatch({ type: "reset", items: draft })
      await loadList()
      toast.success("Menu saved")
    } catch (error) {
      setSaveError(`Couldn't save the menu. ${errorMessage(error)}`)
    } finally {
      setSaving(false)
    }
  }

  // Assigning saves at once: it changes what readers see, not the menu being edited.
  const assign = async (location: string, menuId: string) => {
    try {
      if (menuId === NO_MENU) {
        const holder = menus.find((m) => m.location === location)
        if (holder) await updateMenu(holder.id, { name: holder.name, location: "" })
      } else {
        const menu = menus.find((m) => String(m.id) === menuId)
        if (menu) await updateMenu(menu.id, { name: menu.name, location })
      }
      await loadList()
      toast.success("Location updated")
    } catch (error) {
      toast.error(`Couldn't change the location. ${errorMessage(error)}`)
    }
  }

  const remove = async () => {
    if (selectedId === null) return
    try {
      await deleteMenu(selectedId)
      setConfirmDelete(false)
      setSaved(null)
      setSelectedId(null)
      dispatch({ type: "reset", items: [] })
      const list = await loadList()
      if (list.length) await openMenu(list[0].id)
      toast.success("Menu deleted")
    } catch (error) {
      toast.error(`Couldn't delete the menu. ${errorMessage(error)}`)
    }
  }

  const act = (action: Parameters<typeof menuTreeReducer>[1], key: string) => {
    const next = menuTreeReducer(items, action)
    dispatch(action)
    if (next !== items) setAnnouncement(describePlace(next, key))
  }

  const add = (added: MenuDraftItem[]) => {
    if (countItems(items) + added.length > MAX_MENU_ITEMS) {
      toast.error(`A menu holds at most ${MAX_MENU_ITEMS} items.`)
      return false
    }
    dispatch({ type: "add", items: added })
    setAnnouncement(added.length === 1 ? `Added ${itemName(added[0])}` : `Added ${added.length} items`)
    return true
  }

  const header = (
    <header className="gl-workspace__header">
      <div className="gl-workspace__heading">
        <h1>Menus</h1>
        <span className="gl-workspace__subtitle">The links in your theme's header and footer. Links to posts and pages follow them when their address changes.</span>
      </div>
      <div className="gl-workspace__actions">
        {menus.length > 0 && (
          <Select
            aria-label="Menu to edit"
            value={selectedId === null ? "" : String(selectedId)}
            onChange={(v) => switchMenu(Number(v))}
            options={menus.map((m) => ({ value: String(m.id), label: m.name }))}
            className="gl-menus__picker"
          />
        )}
        <Button variant="secondary" icon={<PlusIcon size={16} />} onClick={() => setCreating(true)}>
          New menu
        </Button>
      </div>
    </header>
  )

  if (loading) {
    return (
      <div className="gl-workspace gl-menus" aria-busy="true">
        {header}
        <Skeleton height={320} />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="gl-workspace gl-menus">
        {header}
        <EmptyState
          variant="error"
          icon="close"
          title="Couldn't load menus"
          description={errorMessage(loadError)}
          action={
            <Button variant="primary" onClick={() => load()}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="gl-workspace gl-menus">
      {header}

      <LocationsSection locations={locations} menus={menus} onAssign={assign} />

      {menus.length === 0 ? (
        <EmptyState
          icon="content"
          title="No menus yet"
          description="Make one, add links to it, then pick where your theme shows it."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create a menu
            </Button>
          }
        />
      ) : (
        <div className="gl-workspace__split">
          <section className="gl-workspace__main" aria-labelledby="gl-menu-structure" aria-busy={loadingMenu || undefined}>
            <div className="gl-workspace__section-head">
              <h2 className="gl-workspace__section-title" id="gl-menu-structure">
                Structure
              </h2>
              <Button variant="ghost" size="sm" icon={<TrashIcon size={16} />} onClick={() => setConfirmDelete(true)} disabled={selectedId === null}>
                Delete menu
              </Button>
            </div>
            <Input title="Menu name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} unmasked />
            <p className="gl-workspace__section-intro">
              Drag items to reorder them, or onto another item to nest them one level. From the keyboard, use each item's Move menu.
            </p>
            {loadingMenu ? (
              <Skeleton height={200} />
            ) : (
              <MenuTreeEditor items={items} onAction={act} />
            )}
            <div className="gl-workspace__sr" role="status" aria-live="polite">
              {announcement}
            </div>
          </section>

          <AddItemsPanel onAdd={add} />
        </div>
      )}

      <UnsavedChangesBar
        visible={dirty}
        message="Unsaved changes to this menu"
        onSave={save}
        onDiscard={discard}
        saving={saving}
        saveLabel="Save menu"
        error={saveError}
      />

      <NewMenuModal
        isOpen={creating}
        locations={locations}
        onClose={() => setCreating(false)}
        onCreated={async (menu) => {
          setCreating(false)
          await loadList()
          await openMenu(menu.id)
        }}
      />

      <Modal
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        role="alertdialog"
        size="small"
        title={`Delete ${saved?.name ?? "this menu"}?`}
        description="Its links are deleted with it, and any location it's in is left empty. Your posts and pages aren't touched."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove}>
              Delete menu
            </Button>
          </>
        }
      >
        {null}
      </Modal>

      <Modal
        isOpen={pendingSwitch !== null}
        onClose={() => setPendingSwitch(null)}
        role="alertdialog"
        size="small"
        title="Discard your changes?"
        description="This menu has changes that aren't saved."
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingSwitch(null)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const id = pendingSwitch
                setPendingSwitch(null)
                if (id !== null) openMenu(id)
              }}
            >
              Discard changes
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </div>
  )
}

function LocationsSection({
  locations,
  menus,
  onAssign,
}: {
  locations: MenuLocation[]
  menus: MenuData[]
  onAssign: (location: string, menuId: string) => void
}) {
  return (
    <section className="gl-workspace__section" aria-labelledby="gl-menu-locations">
      <h2 className="gl-workspace__section-title" id="gl-menu-locations">
        Theme locations
      </h2>
      {locations.length === 0 ? (
        <p className="gl-workspace__section-intro">Your theme doesn't show any menus.</p>
      ) : (
        <ul className="gl-menu-locations" role="list">
          {locations.map((location) => {
            const holder = menus.find((m) => m.location === location.name)
            return (
              <li key={location.name} className="gl-menu-location">
                <div className="gl-menu-location__text">
                  <span className="gl-menu-location__label">{location.label}</span>
                  {location.description && <span className="gl-workspace__muted">{location.description}</span>}
                </div>
                <Select
                  aria-label={`Menu in ${location.label}`}
                  value={holder ? String(holder.id) : NO_MENU}
                  onChange={(v) => onAssign(location.name, v)}
                  options={[{ value: NO_MENU, label: "No menu" }, ...menus.map((m) => ({ value: String(m.id), label: m.name }))]}
                  className="gl-menu-location__select"
                />
              </li>
            )
          })}
        </ul>
      )}
      {locations.length > 0 && <p className="gl-workspace__muted gl-menu-locations__hint">A menu shows in one location at a time: picking it for another moves it.</p>}
    </section>
  )
}

type DropState = { key: string; position: DropPosition } | null

function MenuTreeEditor({ items, onAction }: { items: MenuDraftItem[]; onAction: (action: Parameters<typeof menuTreeReducer>[1], key: string) => void }) {
  const dragKey = useRef<string | null>(null)
  const [drop, setDrop] = useState<DropState>(null)
  const [editing, setEditing] = useState<string | null>(null)

  if (items.length === 0) {
    return <EmptyState compact icon="content" title="This menu is empty" description="Add pages, posts, terms or links from the panel." />
  }

  // Top third: before, bottom third: after, middle: inside (when allowed).
  const positionFor = (event: React.DragEvent<HTMLElement>, target: string): DropPosition | null => {
    const key = dragKey.current
    if (!key) return null
    const rect = event.currentTarget.getBoundingClientRect()
    const y = (event.clientY - rect.top) / Math.max(rect.height, 1)
    const order: DropPosition[] = y < 1 / 3 ? ["before"] : y > 2 / 3 ? ["after"] : ["inside", y < 0.5 ? "before" : "after"]
    return order.find((p) => canDrop(items, key, target, p)) ?? null
  }

  const rowProps = (item: MenuDraftItem) => ({
    draggable: editing !== item.key,
    onDragStart: (event: React.DragEvent<HTMLElement>) => {
      event.stopPropagation()
      dragKey.current = item.key
      event.dataTransfer.effectAllowed = "move"
      event.dataTransfer.setData("text/plain", itemName(item))
    },
    onDragEnd: () => {
      dragKey.current = null
      setDrop(null)
    },
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      event.stopPropagation()
      const position = positionFor(event, item.key)
      if (!position) return
      event.preventDefault()
      if (drop?.key !== item.key || drop.position !== position) setDrop({ key: item.key, position })
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      const key = dragKey.current
      const position = positionFor(event, item.key)
      dragKey.current = null
      setDrop(null)
      if (key && position) onAction({ type: "drop", key, target: item.key, position }, key)
    },
  })

  const renderItem = (item: MenuDraftItem, parent: MenuDraftItem | null) => {
    const moves = availableMoves(items, item.key)
    const isDrop = drop?.key === item.key ? ` is-drop-${drop.position}` : ""
    const status = STATUS_TEXT[item.status]
    return (
      <li key={item.key} className={`gl-menu-item${isDrop}`}>
        <div className="gl-menu-item__row" {...rowProps(item)}>
          <span className="gl-menu-item__grip" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="9" cy="6" r="1.5" />
              <circle cx="15" cy="6" r="1.5" />
              <circle cx="9" cy="12" r="1.5" />
              <circle cx="15" cy="12" r="1.5" />
              <circle cx="9" cy="18" r="1.5" />
              <circle cx="15" cy="18" r="1.5" />
            </svg>
          </span>
          <div className="gl-menu-item__text">
            <span className="gl-menu-item__name">{itemName(item)}</span>
            <span className="gl-menu-item__meta">
              <span className="gl-workspace__badge">{TYPE_LABELS[item.type]}</span>
              {item.href && <span className="gl-workspace__mono">{item.href}</span>}
            </span>
          </div>
          {status && <Pill tone="neutral">{status}</Pill>}
          <div className="gl-menu-item__actions">
            <IconButton
              aria-label={`Edit ${itemName(item)}`}
              aria-expanded={editing === item.key}
              icon={<PencilIcon size={16} />}
              size="sm"
              onClick={() => setEditing(editing === item.key ? null : item.key)}
            />
            <Menu
              label={`Move ${itemName(item)}`}
              placement="bottom-end"
              trigger={(props) => <IconButton {...props} aria-label={`Move ${itemName(item)}`} icon={<MoreIcon size={16} />} size="sm" />}
            >
              <MenuItem disabled={!moves.up} onSelect={() => onAction({ type: "moveUp", key: item.key }, item.key)}>
                Move up
              </MenuItem>
              <MenuItem disabled={!moves.down} onSelect={() => onAction({ type: "moveDown", key: item.key }, item.key)}>
                Move down
              </MenuItem>
              {!parent && (
                <MenuItem disabled={!moves.indent} onSelect={() => onAction({ type: "indent", key: item.key }, item.key)}>
                  Nest under the item above
                </MenuItem>
              )}
              {parent && (
                <MenuItem onSelect={() => onAction({ type: "outdent", key: item.key }, item.key)}>{`Move out of ${itemName(parent)}`}</MenuItem>
              )}
              <MenuItem danger onSelect={() => onAction({ type: "remove", key: item.key }, item.key)}>
                Remove from menu
              </MenuItem>
            </Menu>
          </div>
        </div>
        {editing === item.key && <ItemEditor item={item} onAction={onAction} onDone={() => setEditing(null)} />}
        {item.children.length > 0 && (
          <ul className="gl-menu-tree gl-menu-tree--children" role="list" aria-label={`Under ${itemName(item)}`}>
            {item.children.map((child) => renderItem(child, item))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <ul className="gl-menu-tree" role="list" aria-label="Menu items">
      {items.map((item) => renderItem(item, null))}
    </ul>
  )
}

function ItemEditor({
  item,
  onAction,
  onDone,
}: {
  item: MenuDraftItem
  onAction: (action: Parameters<typeof menuTreeReducer>[1], key: string) => void
  onDone: () => void
}) {
  const [label, setLabel] = useState(item.label)
  const [url, setUrl] = useState(item.url ?? "")
  const custom = item.type === "custom"
  const urlError = custom && !isValidMenuUrl(url.trim()) ? "Use a full http(s) address or a path that starts with /." : undefined
  const labelError = custom && !label.trim() ? "A link needs a label." : undefined

  return (
    <form
      className="gl-menu-item__editor gl-workspace__form"
      onSubmit={(e) => {
        e.preventDefault()
        if (urlError || labelError) return
        onAction({ type: "edit", key: item.key, label, ...(custom && { url: url.trim() }) }, item.key)
        onDone()
      }}
    >
      <Input
        title="Label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        maxLength={200}
        unmasked
        optional={!custom}
        hint={custom ? undefined : `Empty shows “${item.title}”, and follows it when it's renamed.`}
        error={labelError}
      />
      {custom && <Input title="URL" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2048} unmasked error={urlError} />}
      <div className="gl-workspace__panel-actions">
        <Button type="submit" variant="primary" size="sm">
          Apply
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

type Source = "page" | "post" | "term" | "archive" | "custom"

function AddItemsPanel({ onAdd }: { onAdd: (items: MenuDraftItem[]) => boolean }) {
  const [tab, setTab] = useState<Source>("page")
  const panel = (source: Source) => {
    switch (source) {
      case "page":
      case "post":
        return <PostPicker key={source} postType={source} onAdd={onAdd} />
      case "term":
        return <TermPicker onAdd={onAdd} />
      case "archive":
        return <ArchivePicker onAdd={onAdd} />
      case "custom":
        return <CustomLinkForm onAdd={onAdd} />
    }
  }
  return (
    <aside className="gl-workspace__panel gl-menus__add" aria-labelledby="gl-menu-add">
      <h2 id="gl-menu-add">Add items</h2>
      <Tabs
        label="Item sources"
        value={tab}
        onChange={(v) => setTab(v as Source)}
        tabs={(["page", "post", "term", "archive", "custom"] as Source[]).map((id) => ({
          id,
          label: { page: "Pages", post: "Posts", term: "Terms", archive: "Archives", custom: "Link" }[id],
          panel: tab === id ? panel(id) : undefined,
        }))}
      />
    </aside>
  )
}

// A filterable list with an Add button per row.
function PickList<T>({
  label,
  rows,
  loading,
  error,
  rowKey,
  rowName,
  rowNote,
  onAdd,
}: {
  label: string
  rows: T[]
  loading: boolean
  error: unknown
  rowKey: (row: T) => string
  rowName: (row: T) => string
  rowNote?: (row: T) => string | undefined
  onAdd: (row: T) => void
}) {
  const [query, setQuery] = useState("")
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? rows.filter((r) => rowName(r).toLowerCase().includes(q)) : rows
  }, [rows, query, rowName])

  if (loading) return <Skeleton height={160} />
  if (error) return <p className="gl-workspace__muted">Couldn't load them. {errorMessage(error)}</p>
  return (
    <div className="gl-menu-pick">
      <Input title={`Filter ${label}`} hideLabel placeholder={`Filter ${label}`} value={query} onChange={(e) => setQuery(e.target.value)} unmasked />
      {shown.length === 0 ? (
        <p className="gl-workspace__muted">{rows.length ? "Nothing matches." : `No ${label} yet.`}</p>
      ) : (
        <ul className="gl-menu-pick__list" role="list" aria-label={label}>
          {shown.map((row) => (
            <li key={rowKey(row)} className="gl-menu-pick__row">
              <span className="gl-menu-pick__name">
                {rowName(row)}
                {rowNote?.(row) && <span className="gl-workspace__muted"> · {rowNote(row)}</span>}
              </span>
              <Button variant="secondary" size="sm" aria-label={`Add ${rowName(row)}`} onClick={() => onAdd(row)}>
                Add
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function useLoader<T>(load: () => Promise<T>, deps: React.DependencyList) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: unknown }>({ data: null, loading: true, error: null })
  useEffect(() => {
    let live = true
    setState({ data: null, loading: true, error: null })
    load()
      .then((data) => live && setState({ data, loading: false, error: null }))
      .catch((error) => live && setState({ data: null, loading: false, error }))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

function PostPicker({ postType, onAdd }: { postType: "page" | "post"; onAdd: (items: MenuDraftItem[]) => boolean }) {
  // The most recent 100; the filter narrows them.
  const { data, loading, error } = useLoader(
    () => getPosts({ type: postType, status: "draft,published", limit: 100 }).then((r) => r.data),
    [postType]
  )
  return (
    <PickList<Post>
      label={postType === "page" ? "pages" : "posts"}
      rows={data ?? []}
      loading={loading}
      error={error}
      rowKey={(p) => String(p.id)}
      rowName={(p) => p.title || "(untitled)"}
      rowNote={(p) => (p.post_status === "published" ? undefined : "draft")}
      onAdd={(p) =>
        onAdd([
          {
            key: newItemKey(),
            type: "post",
            label: "",
            targetId: p.id,
            postType: p.post_type,
            title: p.title,
            href: "",
            status: p.post_status === "published" ? "visible" : "unpublished",
            children: [],
          },
        ])
      }
    />
  )
}

function TermPicker({ onAdd }: { onAdd: (items: MenuDraftItem[]) => boolean }) {
  const types = useLoader(() => getTaxonomyTypes().then((r) => r.data.filter((t) => t.show_ui !== false)), [])
  const [typeName, setTypeName] = useState<string>("")
  const current: TaxonomyType | undefined = types.data?.find((t) => t.name === typeName) ?? types.data?.[0]
  const terms = useLoader(() => (current ? getAllTaxonomyTerms(current.name) : Promise.resolve([] as TaxonomyTerm[])), [current?.name])

  if (types.loading) return <Skeleton height={160} />
  if (types.error || !current) return <p className="gl-workspace__muted">No taxonomies to pick from.</p>
  return (
    <div className="gl-workspace__form">
      <Select label="Taxonomy" value={current.name} onChange={setTypeName} options={(types.data ?? []).map((t) => ({ value: t.name, label: t.label }))} />
      <PickList<TaxonomyTerm>
        label={current.label.toLowerCase()}
        rows={terms.data ?? []}
        loading={terms.loading}
        error={terms.error}
        rowKey={(t) => String(t.id)}
        rowName={(t) => t.name}
        onAdd={(t) =>
          onAdd([
            {
              key: newItemKey(),
              type: "term",
              label: "",
              targetId: t.id,
              title: t.name,
              href: "",
              status: current.public === false ? "not_public" : "visible",
              children: [],
            },
          ])
        }
      />
    </div>
  )
}

function ArchivePicker({ onAdd }: { onAdd: (items: MenuDraftItem[]) => boolean }) {
  const { data, loading, error } = useLoader(() => getPostTypes().then((r) => r.data.filter((t) => t.public !== false && t.is_active !== false)), [])
  return (
    <PickList<PostType>
      label="archives"
      rows={data ?? []}
      loading={loading}
      error={error}
      rowKey={(t) => t.name}
      rowName={(t) => t.label}
      rowNote={(t) => `/${t.name}`}
      onAdd={(t) =>
        onAdd([{ key: newItemKey(), type: "archive", label: "", postType: t.name, title: t.label, href: `/${t.name}`, status: "visible", children: [] }])
      }
    />
  )
}

function CustomLinkForm({ onAdd }: { onAdd: (items: MenuDraftItem[]) => boolean }) {
  const [url, setUrl] = useState("")
  const [label, setLabel] = useState("")
  const [tried, setTried] = useState(false)
  const urlError = tried && !isValidMenuUrl(url.trim()) ? "Use a full http(s) address or a path that starts with /." : undefined
  const labelError = tried && !label.trim() ? "A link needs a label." : undefined

  return (
    <form
      className="gl-workspace__form"
      onSubmit={(e) => {
        e.preventDefault()
        setTried(true)
        const href = url.trim()
        if (!isValidMenuUrl(href) || !label.trim()) return
        const added = onAdd([{ key: newItemKey(), type: "custom", label: label.trim(), url: href, title: label.trim(), href, status: "visible", children: [] }])
        if (added) {
          setUrl("")
          setLabel("")
          setTried(false)
        }
      }}
      noValidate
    >
      <Input title="URL" placeholder="https://… or /about" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2048} unmasked error={urlError} />
      <Input title="Label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} unmasked error={labelError} />
      <div className="gl-workspace__panel-actions">
        <Button type="submit" variant="secondary">
          Add link
        </Button>
      </div>
    </form>
  )
}

function NewMenuModal({
  isOpen,
  locations,
  onClose,
  onCreated,
}: {
  isOpen: boolean
  locations: MenuLocation[]
  onClose: () => void
  onCreated: (menu: MenuData) => void
}) {
  const [name, setName] = useState("")
  const [location, setLocation] = useState(NO_MENU)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      setName("")
      setLocation(NO_MENU)
      setError(null)
    }
  }, [isOpen])

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="New menu"
      size="medium"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="gl-new-menu" loading={saving}>
            Create menu
          </Button>
        </>
      }
    >
      <form
        id="gl-new-menu"
        className="gl-workspace__form"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!name.trim()) {
            setError("Give the menu a name.")
            return
          }
          setSaving(true)
          try {
            onCreated(await createMenu({ name: name.trim(), ...(location && { location }) }))
          } catch (err) {
            setError(`Couldn't create the menu. ${errorMessage(err)}`)
          } finally {
            setSaving(false)
          }
        }}
        noValidate
      >
        <Input title="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} unmasked error={error ?? undefined} hint="Only you and other editors see it." />
        {locations.length > 0 && (
          <Select
            label="Show it in"
            value={location}
            onChange={setLocation}
            options={[{ value: NO_MENU, label: "Not yet" }, ...locations.map((l) => ({ value: l.name, label: l.label }))]}
          />
        )}
      </form>
    </Modal>
  )
}

export default MenusPage
