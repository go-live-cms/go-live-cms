import type { MenuItem, MenuItemInput, MenuItemStatus, MenuItemType } from "@gl-admin/lib/api/menus"

// The Menus screen's item tree (#347): the editor works on a local copy and saves it
// whole (PUT /menus/:id/items). Menus nest one level deep, as the API stores them:
// a top-level item may have children, a child can't.
//
// Every change goes through menuTreeReducer, so drag and drop and the keyboard
// alternative (the row's Move menu) are the same operations.

export interface MenuDraftItem {
  // Local identity: the stored id for saved items, a fresh key for new ones.
  key: string
  type: MenuItemType
  label: string
  targetId?: number
  postType?: string
  url?: string
  // The target's title and the reader's URL as last loaded (new items: what was picked).
  title: string
  href: string
  status: MenuItemStatus
  children: MenuDraftItem[]
}

let nextKey = 0
export const newItemKey = () => `new-${++nextKey}`

export function draftFromApi(items: MenuItem[] = []): MenuDraftItem[] {
  return items.map((item) => ({
    key: String(item.id),
    type: item.type,
    label: item.label,
    targetId: item.target_id,
    postType: item.post_type,
    url: item.type === "custom" ? item.url : undefined,
    title: item.title,
    href: item.url,
    status: item.status,
    children: draftFromApi(item.children),
  }))
}

// The request body: only what the API stores.
export function draftToRequest(items: MenuDraftItem[]): MenuItemInput[] {
  return items.map((item) => {
    const input: MenuItemInput = { type: item.type }
    const label = item.label.trim()
    if (label) input.label = label
    if (item.type === "post" || item.type === "term") input.target_id = item.targetId
    if (item.type === "archive") input.post_type = item.postType
    if (item.type === "custom") input.url = item.url
    if (item.children.length) input.children = draftToRequest(item.children)
    return input
  })
}

// The API's rule for a custom link (validMenuURL in api/menus_utils.go): an http(s)
// URL with a host, or a path on this site. Never javascript: or //host.
export function isValidMenuUrl(raw: string): boolean {
  if (!raw || raw.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(raw)) return false
  if (raw.startsWith("/")) return !raw.startsWith("//") && !raw.startsWith("/\\")
  try {
    const url = new URL(raw)
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.host
  } catch {
    return false
  }
}

// The API's cap on a menu, children included (maxMenuItems).
export const MAX_MENU_ITEMS = 200

// What a row shows: the label, else the target's title.
export const itemName = (item: MenuDraftItem) => item.label.trim() || item.title || "(untitled)"

export function countItems(items: MenuDraftItem[]): number {
  return items.reduce((n, item) => n + 1 + item.children.length, 0)
}

// Where an item sits: its parent (null at the top level) and index among siblings.
export interface ItemPlace {
  parent: MenuDraftItem | null
  index: number
  siblings: MenuDraftItem[]
}

export function findItem(items: MenuDraftItem[], key: string): (ItemPlace & { item: MenuDraftItem }) | null {
  for (let i = 0; i < items.length; i++) {
    if (items[i].key === key) return { item: items[i], parent: null, index: i, siblings: items }
    const children = items[i].children
    const j = children.findIndex((c) => c.key === key)
    if (j >= 0) return { item: children[j], parent: items[i], index: j, siblings: children }
  }
  return null
}

export type DropPosition = "before" | "after" | "inside"

export type MenuTreeAction =
  | { type: "reset"; items: MenuDraftItem[] }
  | { type: "add"; items: MenuDraftItem[] }
  | { type: "remove"; key: string }
  | { type: "edit"; key: string; label?: string; url?: string }
  | { type: "moveUp"; key: string }
  | { type: "moveDown"; key: string }
  // Make the item a child of the top-level item above it.
  | { type: "indent"; key: string }
  // Make a child a top-level item, right after its parent.
  | { type: "outdent"; key: string }
  // A drop from drag and drop: before or after the target, or as its last child.
  | { type: "drop"; key: string; target: string; position: DropPosition }

// What a row's Move menu offers; the reducer ignores the rest.
export function availableMoves(items: MenuDraftItem[], key: string) {
  const place = findItem(items, key)
  if (!place) return { up: false, down: false, indent: false, outdent: false }
  const { item, parent, index, siblings } = place
  return {
    up: index > 0,
    down: index < siblings.length - 1,
    // Only a top-level item without children, under the top-level item above it.
    indent: !parent && index > 0 && item.children.length === 0,
    outdent: !!parent,
  }
}

export function canDrop(items: MenuDraftItem[], key: string, target: string, position: DropPosition): boolean {
  if (key === target) return false
  const from = findItem(items, key)
  const to = findItem(items, target)
  if (!from || !to) return false
  // Can't land inside itself (its own child).
  if (to.parent?.key === key) return false
  if (position === "inside") return !to.parent && from.item.children.length === 0
  // Beside a child = becoming a child: only items without children of their own.
  if (to.parent) return from.item.children.length === 0
  return true
}

// A copy of the tree without the item (its children go with it).
function without(items: MenuDraftItem[], key: string): MenuDraftItem[] {
  return items
    .filter((item) => item.key !== key)
    .map((item) => (item.children.some((c) => c.key === key) ? { ...item, children: item.children.filter((c) => c.key !== key) } : item))
}

function withChildren(items: MenuDraftItem[], parentKey: string, children: MenuDraftItem[]): MenuDraftItem[] {
  return items.map((item) => (item.key === parentKey ? { ...item, children } : item))
}

function insertAt<T>(list: T[], index: number, value: T): T[] {
  return [...list.slice(0, index), value, ...list.slice(index)]
}

function swap(items: MenuDraftItem[], key: string, delta: -1 | 1): MenuDraftItem[] {
  const place = findItem(items, key)
  if (!place) return items
  const to = place.index + delta
  if (to < 0 || to >= place.siblings.length) return items
  const siblings = [...place.siblings]
  ;[siblings[place.index], siblings[to]] = [siblings[to], siblings[place.index]]
  return place.parent ? withChildren(items, place.parent.key, siblings) : siblings
}

export function menuTreeReducer(items: MenuDraftItem[], action: MenuTreeAction): MenuDraftItem[] {
  switch (action.type) {
    case "reset":
      return action.items
    case "add":
      return [...items, ...action.items]
    case "remove": {
      const place = findItem(items, action.key)
      if (!place) return items
      // A removed parent's children take its place, so nothing else disappears.
      if (!place.parent && place.item.children.length) {
        const rest = items.filter((item) => item.key !== action.key)
        return [...rest.slice(0, place.index), ...place.item.children, ...rest.slice(place.index)]
      }
      return without(items, action.key)
    }
    case "edit": {
      const patch = (item: MenuDraftItem): MenuDraftItem =>
        item.key === action.key
          ? { ...item, ...(action.label !== undefined && { label: action.label }), ...(action.url !== undefined && item.type === "custom" && { url: action.url, href: action.url }) }
          : { ...item, children: item.children.map(patch) }
      return items.map(patch)
    }
    case "moveUp":
      return swap(items, action.key, -1)
    case "moveDown":
      return swap(items, action.key, 1)
    case "indent": {
      if (!availableMoves(items, action.key).indent) return items
      const place = findItem(items, action.key)!
      const newParent = items[place.index - 1]
      const rest = without(items, action.key)
      return withChildren(rest, newParent.key, [...newParent.children, place.item])
    }
    case "outdent": {
      const place = findItem(items, action.key)
      if (!place?.parent) return items
      const rest = without(items, action.key)
      const parentIndex = rest.findIndex((item) => item.key === place.parent!.key)
      return insertAt(rest, parentIndex + 1, place.item)
    }
    case "drop": {
      if (!canDrop(items, action.key, action.target, action.position)) return items
      const moving = findItem(items, action.key)!.item
      const rest = without(items, action.key)
      const target = findItem(rest, action.target)!
      if (action.position === "inside") return withChildren(rest, target.item.key, [...target.item.children, moving])
      const index = target.index + (action.position === "after" ? 1 : 0)
      if (target.parent) return withChildren(rest, target.parent.key, insertAt(target.siblings, index, moving))
      return insertAt(rest, index, moving)
    }
  }
}

// Whether the local tree differs from what was saved (compares what would be sent).
export function isDirty(saved: MenuDraftItem[], current: MenuDraftItem[]): boolean {
  return JSON.stringify(draftToRequest(saved)) !== JSON.stringify(draftToRequest(current))
}

// Says where an item ended up, for the screen reader announcement after a move.
export function describePlace(items: MenuDraftItem[], key: string): string {
  const place = findItem(items, key)
  if (!place) return ""
  const position = `${place.index + 1} of ${place.siblings.length}`
  return place.parent ? `${itemName(place.item)}: under ${itemName(place.parent)}, ${position}` : `${itemName(place.item)}: top level, ${position}`
}
