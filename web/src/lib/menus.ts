/**
 * Navigation menus on the public site (#347). Themes declare locations in
 * theme.config.ts (`menuLocations`) and the admin assigns a menu to each; the
 * API's GET /public/menus/:location returns it with every URL already resolved
 * from its target (so links follow slug changes) and only the items readers may
 * follow.
 */
import { SERVER_MEDIA_URL } from "@gl-admin/lib/server-api-url"

export interface MenuLink {
  id: number
  label: string
  url: string
  children: MenuLink[]
  // Set by withCurrent: this link is the page being viewed.
  current?: boolean
}

export interface Menu {
  name: string
  location: string
  items: MenuLink[]
}

// The header and footer render this on every page; an API that doesn't answer
// shouldn't hold the page up, so give up and render without the menu.
const MENU_TIMEOUT_MS = 2000

export async function getMenu(location: string, fetcher: typeof fetch = fetch, timeoutMs = MENU_TIMEOUT_MS): Promise<Menu | null> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // The abort alone doesn't end a DNS lookup that hangs (an unreachable API host), so
  // the timer also settles the race itself.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  const load = async () => {
    const response = await fetcher(`${SERVER_MEDIA_URL}/public/menus/${encodeURIComponent(location)}`, { signal: controller.signal })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return normalizeMenu(await response.json())
  }
  try {
    return await Promise.race([load(), timeout])
  } catch (error) {
    console.warn(`[theme] Could not fetch the ${location} menu:`, error)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// The API only stores http(s) and site-relative URLs; check again here so a theme
// never renders anything else into an href.
export function safeMenuHref(url: unknown): string | null {
  if (typeof url !== "string" || url === "" || /[\s\u0000-\u001f]/.test(url)) return null
  if (url.startsWith("/")) return url.startsWith("//") || url.startsWith("/\\") ? null : url
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null
  } catch {
    return null
  }
}

function normalizeLinks(value: unknown, depth: number): MenuLink[] {
  if (!Array.isArray(value)) return []
  const links: MenuLink[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue
    const item = raw as Record<string, unknown>
    const url = safeMenuHref(item.url)
    const label = typeof item.label === "string" ? item.label.trim() : ""
    if (!url || !label) continue
    links.push({
      id: Number(item.id) || 0,
      label,
      url,
      // One level of nesting, as the API stores it.
      children: depth === 0 ? normalizeLinks(item.children, 1) : [],
    })
  }
  return links
}

// A menu as the theme can trust it: labelled links with safe URLs, one level deep.
// null when there's nothing to show.
export function normalizeMenu(value: unknown): Menu | null {
  if (!value || typeof value !== "object") return null
  const data = value as Record<string, unknown>
  const items = normalizeLinks(data.items, 0)
  if (items.length === 0) return null
  return {
    name: typeof data.name === "string" ? data.name : "",
    location: typeof data.location === "string" ? data.location : "",
    items,
  }
}

const trimPath = (path: string) => path.replace(/\/+$/, "") || "/"

// Marks the links to the page being viewed (aria-current). Only site-relative
// links can match; the query and hash are ignored.
export function withCurrent(items: MenuLink[], pathname: string): MenuLink[] {
  const here = trimPath(pathname)
  const mark = (link: MenuLink): MenuLink => {
    const path = link.url.startsWith("/") ? trimPath(link.url.split(/[?#]/)[0]) : null
    return { ...link, current: path === here, children: link.children.map(mark) }
  }
  return items.map(mark)
}

export interface FooterColumn {
  // The top-level link the column is made of; null for the "Site" column.
  heading: MenuLink | null
  links: MenuLink[]
}

// The footer's link columns: each top-level link with children is a column headed by
// its label, and the top-level links without children are collected in one column
// (the theme titles it "Site"), in the place of the first of them.
export function footerColumns(items: MenuLink[]): FooterColumn[] {
  const columns: FooterColumn[] = []
  let loose: FooterColumn | null = null
  for (const item of items) {
    if (item.children.length > 0) {
      columns.push({ heading: item, links: item.children })
    } else {
      if (!loose) {
        loose = { heading: null, links: [] }
        columns.push(loose)
      }
      loose.links.push(item)
    }
  }
  return columns
}
