import { apiCall } from "../api"

// Navigation menus (#347, api/menus_routes.go). Every route is for editors and admins
// (requireContentEditor). The theme's locations come from the active theme's config
// (`menu_locations`, from menuLocations in theme.config.ts).

export type MenuItemType = "post" | "term" | "archive" | "custom"

// visible: readers get it. The others are kept but left out of the public menu.
export type MenuItemStatus = "visible" | "unpublished" | "not_public" | "missing"

export interface MenuItem {
  id: number
  type: MenuItemType
  // As stored: "" shows the target's title.
  label: string
  target_id?: number
  post_type?: string
  // What readers see: the label, or the target's current title, and its URL now.
  title: string
  url: string
  status: MenuItemStatus
  children: MenuItem[]
}

export interface Menu {
  id: number
  name: string
  // "" = not assigned.
  location: string
  item_count?: number
  items?: MenuItem[]
  created_at: string
  changed_at: string
}

export interface MenuLocation {
  name: string
  label: string
  description?: string
}

export interface MenuItemInput {
  type: MenuItemType
  label?: string
  target_id?: number
  post_type?: string
  url?: string
  children?: MenuItemInput[]
}

export async function listMenus(): Promise<Menu[]> {
  const response = await apiCall("/menus")
  return response.menus || []
}

export async function getMenu(id: number): Promise<Menu> {
  return (await apiCall(`/menus/${id}`)).menu
}

export async function createMenu(data: { name: string; location?: string }): Promise<Menu> {
  return (await apiCall("/menus", { method: "POST", body: data })).menu
}

// Renames a menu and sets its location ("" = none); assigning a location takes it from
// the menu that had it. Without `location` the menu keeps the one it has.
export async function updateMenu(id: number, data: { name: string; location?: string }): Promise<Menu> {
  return (await apiCall(`/menus/${id}`, { method: "PUT", body: data })).menu
}

// Replaces the menu's whole item tree.
export async function saveMenuItems(id: number, items: MenuItemInput[]): Promise<Menu> {
  return (await apiCall(`/menus/${id}/items`, { method: "PUT", body: { items } })).menu
}

export async function deleteMenu(id: number): Promise<void> {
  await apiCall(`/menus/${id}`, { method: "DELETE" })
}
