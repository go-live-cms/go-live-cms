import { canCreateContent, isContentModerator, isSiteAdmin } from "@gl-admin/lib/roles"
import type { PostType, TaxonomyType } from "@gl-admin/lib/api/types"

// The sidebar's navigation (#339), as data so the role rules are testable. Who sees
// what is a UI hint only (lib/roles.ts): the API enforces the real checks, and the
// router guards the admin-only pages (RequireRole in app.tsx).

export type NavIcon = "home" | "new" | "post" | "page" | "content" | "media" | "users" | "types" | "themes" | "settings"

export type NavItem = {
  key: string
  label: string
  to: string
  icon: NavIcon
  // Nested links under a disclosure (Posts › All posts, Categories, Tags).
  children?: NavItem[]
}

export type NavSection = {
  key: string
  // Visible heading ("Content", "Workspace"); none for the top group.
  label?: string
  items: NavItem[]
}

// Who may see an entry; each mirrors the API's guard for what the page does.
type Access = (role: string | null | undefined) => boolean
type GatedItem = Omit<NavItem, "children"> & { access?: Access; children?: GatedItem[] }
type GatedSection = Omit<NavSection, "items"> & { access?: Access; items: GatedItem[] }

const ICONS: Record<string, NavIcon> = { post: "post", page: "page" }

// Before /post-types answers, so the menu doesn't jump in.
export const DEFAULT_POST_TYPES = [
  { name: "post", label: "Posts", menu_position: 5 },
  { name: "page", label: "Pages", menu_position: 20 },
] as PostType[]

// Post types in menu order: menu_position (nulls last), then label.
export function sortPostTypes(postTypes: PostType[]): PostType[] {
  return postTypes
    .filter((pt) => pt.show_in_menu !== false)
    .sort((a, b) => (a.menu_position ?? 999) - (b.menu_position ?? 999) || a.label.localeCompare(b.label))
}

// A taxonomy type doesn't say which post type it's for. Seeded names follow
// `<type>_<taxonomy>` for anything but posts (page_category), so those go under
// their type and the rest (category, tag) under Posts.
// The longest matching name wins, so case_study_tag belongs to case_study, not case.
function taxonomyOwner(taxonomy: TaxonomyType, typeNames: string[]): string {
  const owners = typeNames.filter((name) => name !== "post" && taxonomy.name.startsWith(`${name}_`))
  return owners.sort((a, b) => b.length - a.length)[0] ?? "post"
}

// Only categories and tags get a menu entry, as in the design; any other taxonomy type
// is a tab on the Taxonomies page, so a site with many doesn't flood the sidebar.
const MENU_TAXONOMIES = ["category", "tag"]

function inMenu(taxonomy: TaxonomyType, owner: string): boolean {
  const kind = owner === "post" ? taxonomy.name : taxonomy.name.slice(owner.length + 1)
  return MENU_TAXONOMIES.includes(kind)
}

type BuildOptions = {
  role: string | null | undefined
  postTypes?: PostType[]
  taxonomyTypes?: TaxonomyType[]
}

export function buildNavigation({ role, postTypes = DEFAULT_POST_TYPES, taxonomyTypes = [] }: BuildOptions): NavSection[] {
  const types = sortPostTypes(postTypes)
  const typeNames = types.map((pt) => pt.name)
  const visibleTaxonomies = taxonomyTypes.filter((t) => t.show_ui !== false)

  const typeItems: GatedItem[] = types.map((pt) => {
    const taxonomies: GatedItem[] = visibleTaxonomies
      .filter((t) => taxonomyOwner(t, typeNames) === pt.name && inMenu(t, pt.name))
      .map((t) => ({
        key: `taxonomy-${t.name}`,
        label: t.label,
        to: `/taxonomies?type=${encodeURIComponent(t.name)}`,
        icon: "content",
        // Terms are managed by editors and admins (requireContentEditor).
        access: isContentModerator,
      }))
    const to = `/content/${pt.name}`
    return {
      key: `type-${pt.name}`,
      label: pt.label,
      to,
      icon: ICONS[pt.name] ?? "content",
      children: taxonomies.length
        ? [{ key: `type-${pt.name}-all`, label: `All ${pt.label.toLowerCase()}`, to, icon: ICONS[pt.name] ?? "content" }, ...taxonomies]
        : undefined,
    }
  })

  const sections: GatedSection[] = [
    {
      key: "top",
      items: [
        { key: "home", label: "Home", to: "/", icon: "home" },
        // Contributors write drafts too (requireContentAuthor).
        { key: "new-post", label: "New post", to: "/content/post/new", icon: "new", access: canCreateContent },
      ],
    },
    {
      key: "content",
      label: "Content",
      items: [...typeItems, { key: "media", label: "Media", to: "/media", icon: "media" }],
    },
    {
      // Users and invitations, post types, themes and settings: writes are admin-only
      // in the API (requireSiteAdmin), and so are the pages.
      key: "workspace",
      label: "Workspace",
      access: isSiteAdmin,
      items: [
        { key: "users", label: "Users", to: "/users", icon: "users" },
        { key: "post-types", label: "Post types", to: "/post-types", icon: "types" },
        { key: "themes", label: "Themes", to: "/themes", icon: "themes" },
        { key: "settings", label: "Settings", to: "/settings", icon: "settings" },
      ],
    },
  ]

  return filterByRole(sections, role)
}

function filterByRole(sections: GatedSection[], role: string | null | undefined): NavSection[] {
  const allowed = (x: { access?: Access }) => !x.access || x.access(role)
  const strip = ({ access: _access, children, ...item }: GatedItem): NavItem => {
    const kept = children?.filter(allowed).map(strip)
    // Only "All posts" left: no disclosure, just the link.
    return kept && kept.length > 1 ? { ...item, children: kept } : item
  }
  return sections
    .filter(allowed)
    .map(({ access: _access, items, ...section }) => ({ ...section, items: items.filter(allowed).map(strip) }))
    .filter((section) => section.items.length > 0)
}

const trim = (path: string) => path.replace(/\/+$/, "") || "/"

// The key of the item for the current page. The longest matching link wins, so
// /content/post/new is "New post", not "Posts"; a nested link beats its parent on a
// tie; a link with a query (a taxonomy tab) needs those params too.
export function activeKey(sections: NavSection[], pathname: string, search = ""): string | null {
  const path = trim(pathname)
  const params = new URLSearchParams(search)
  let best: { key: string; score: number } | null = null

  const visit = (item: NavItem, depth: number) => {
    const [base, query] = item.to.split("?")
    const target = trim(base)
    const pathMatches = target === "/" ? path === "/" : path === target || path.startsWith(`${target}/`)
    const wanted = Array.from(new URLSearchParams(query ?? ""))
    const queryMatches = wanted.every(([k, v]) => params.get(k) === v)
    if (pathMatches && queryMatches) {
      const score = target.length * 100 + wanted.length * 10 + depth
      if (!best || score > best.score) best = { key: item.key, score }
    }
    item.children?.forEach((child) => visit(child, depth + 1))
  }

  sections.forEach((section) => section.items.forEach((item) => visit(item, 0)))
  return best ? (best as { key: string }).key : null
}

// The top-level item that holds `key` (itself, or the parent of a nested link).
export function parentOf(sections: NavSection[], key: string | null): NavItem | null {
  if (!key) return null
  for (const section of sections) {
    for (const item of section.items) {
      if (item.key === key || item.children?.some((c) => c.key === key)) return item
    }
  }
  return null
}
