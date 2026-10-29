import { describe, expect, it } from "vitest"
import type { PostType, TaxonomyType } from "@gl-admin/lib/api/types"
import { activeKey, buildNavigation, parentOf, type NavSection } from "./nav"

// The sidebar's role-aware navigation (#339). A UI hint only: the API and RequireRole
// enforce the rules, but nobody should be shown a link to a page that refuses them.

const POST_TYPES = [
  { name: "page", label: "Pages", menu_position: 20 },
  { name: "post", label: "Posts", menu_position: 5 },
  { name: "recipe", label: "Recipes", menu_position: null },
  { name: "hidden", label: "Hidden", menu_position: 1, show_in_menu: false },
] as PostType[]

const TAXONOMIES = [
  { name: "category", label: "Categories" },
  { name: "tag", label: "Tags" },
  { name: "page_category", label: "Page Categories" },
  // Other types stay on the Taxonomies page.
  { name: "test_count", label: "Test Count" },
] as TaxonomyType[]

const keys = (sections: NavSection[]) =>
  sections.flatMap((s) => s.items.flatMap((i) => [i.key, ...(i.children ?? []).map((c) => c.key)]))

const build = (role: string | undefined) => buildNavigation({ role, postTypes: POST_TYPES, taxonomyTypes: TAXONOMIES })

describe("buildNavigation", () => {
  it("gives admins every section, with the workspace pages", () => {
    const nav = build("admin")
    expect(nav.map((s) => s.key)).toEqual(["top", "content", "workspace"])
    expect(nav.find((s) => s.key === "workspace")!.items.map((i) => i.label)).toEqual(["Users", "Themes", "Settings"])
  })

  it("hides Users, Settings, Themes and Post types from contributors", () => {
    const visible = keys(build("contributor"))
    for (const key of ["users", "settings", "themes", "post-types"]) expect(visible).not.toContain(key)
    expect(build("contributor").map((s) => s.label)).not.toContain("Workspace")
    // What they can use stays.
    expect(visible).toEqual(expect.arrayContaining(["home", "new-post", "type-post", "type-page", "media"]))
  })

  it("shows categories and tags to editors but not contributors", () => {
    const editor = keys(build("editor"))
    expect(editor).toEqual(expect.arrayContaining(["taxonomy-category", "taxonomy-tag"]))
    // Editors aren't site admins.
    expect(editor).not.toContain("users")

    const contributor = build("contributor")
    expect(keys(contributor).filter((k) => k.startsWith("taxonomy-"))).toEqual([])
    // With only "All posts" left, Posts is a plain link, not a disclosure.
    expect(contributor[1].items.find((i) => i.key === "type-post")!.children).toBeUndefined()
  })

  it("shows nothing role-gated to an unknown or missing role", () => {
    const visible = keys(build(undefined))
    expect(visible).not.toContain("new-post")
    expect(visible).not.toContain("users")
    expect(visible).not.toContain("taxonomy-category")
  })

  it("orders post types by menu position, skips hidden ones, and nests page taxonomies under Pages", () => {
    const content = build("admin")[1]
    expect(content.items.map((i) => i.label)).toEqual(["Posts", "Pages", "Recipes", "Media"])
    const posts = content.items[0]
    expect(posts.children!.map((c) => c.label)).toEqual(["All posts", "Categories", "Tags"])
    expect(content.items[1].children!.map((c) => c.label)).toEqual(["All pages", "Page Categories"])
    expect(posts.children![1].to).toBe("/taxonomies?type=category")
  })
})

describe("activeKey", () => {
  const nav = build("admin")

  it("picks the longest match, so New post wins over Posts", () => {
    expect(activeKey(nav, "/")).toBe("home")
    expect(activeKey(nav, "/content/post/new")).toBe("new-post")
    expect(activeKey(nav, "/content/recipe/")).toBe("type-recipe")
    expect(activeKey(nav, "/users/edit/3")).toBe("users")
  })

  it("marks the nested link, not its parent, and matches taxonomy tabs by query", () => {
    expect(activeKey(nav, "/content/post")).toBe("type-post-all")
    expect(parentOf(nav, "type-post-all")!.key).toBe("type-post")
    expect(activeKey(nav, "/taxonomies", "?type=tag")).toBe("taxonomy-tag")
    expect(activeKey(nav, "/taxonomies", "?type=nope")).toBeNull()
  })

  it("matches nothing for a page outside the menu", () => {
    expect(activeKey(nav, "/profile")).toBeNull()
    expect(activeKey(nav, "/content/edit/12")).toBeNull()
  })
})
