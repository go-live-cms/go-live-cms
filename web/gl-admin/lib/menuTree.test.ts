import { describe, expect, it } from "vitest"
import {
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
  type MenuDraftItem,
} from "./menuTree"
import type { MenuItem } from "./api/menus"

const item = (key: string, children: MenuDraftItem[] = []): MenuDraftItem => ({
  key,
  type: "custom",
  label: key.toUpperCase(),
  url: `/${key}`,
  title: "",
  href: `/${key}`,
  status: "visible",
  children,
})

// The tree's shape as nested keys: "a(b,c) d".
const shape = (items: MenuDraftItem[]): string =>
  items.map((i) => (i.children.length ? `${i.key}(${i.children.map((c) => c.key).join(",")})` : i.key)).join(" ")

const tree = () => [item("a", [item("b"), item("c")]), item("d"), item("e")]

describe("draftFromApi / draftToRequest (menu tree building)", () => {
  const api: MenuItem[] = [
    {
      id: 1, type: "post", label: "", target_id: 42, post_type: "page", title: "About us", url: "/page/about", status: "visible",
      children: [{ id: 2, type: "custom", label: "Team", title: "Team", url: "/team", status: "visible", children: [] }],
    },
    { id: 3, type: "term", label: "News", target_id: 5, title: "News", url: "/category/news", status: "not_public", children: [] },
    { id: 4, type: "archive", label: "", post_type: "post", title: "Posts", url: "/post", status: "visible", children: [] },
  ]

  it("keeps the tree, the targets and what readers see", () => {
    const draft = draftFromApi(api)
    expect(shape(draft)).toBe("1(2) 3 4")
    expect(draft[0]).toMatchObject({ key: "1", type: "post", targetId: 42, title: "About us", href: "/page/about", url: undefined })
    expect(draft[1].status).toBe("not_public")
    expect(itemName(draft[0])).toBe("About us")
    expect(itemName(draft[1])).toBe("News")
    expect(countItems(draft)).toBe(4)
  })

  it("sends only what the API stores, children nested", () => {
    expect(draftToRequest(draftFromApi(api))).toEqual([
      { type: "post", target_id: 42, children: [{ type: "custom", label: "Team", url: "/team" }] },
      { type: "term", label: "News", target_id: 5 },
      { type: "archive", post_type: "post" },
    ])
  })

  it("is dirty only when the request would change", () => {
    const saved = draftFromApi(api)
    expect(isDirty(saved, draftFromApi(api))).toBe(false)
    expect(isDirty(saved, menuTreeReducer(saved, { type: "moveDown", key: "3" }))).toBe(true)
    expect(isDirty(saved, menuTreeReducer(saved, { type: "edit", key: "4", label: "  " }))).toBe(false)
  })
})

describe("isValidMenuUrl", () => {
  it("takes http(s) and site paths, like the API", () => {
    for (const ok of ["/", "/about", "https://example.com", "http://example.com/a?b=1"]) expect(isValidMenuUrl(ok)).toBe(true)
    for (const bad of ["", "javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "//evil.example", "/\\evil", "about", "/a b", "https://"]) {
      expect(isValidMenuUrl(bad)).toBe(false)
    }
  })
})

describe("menuTreeReducer (reorder and nest)", () => {
  it("adds at the end and removes; a removed parent's children take its place", () => {
    expect(shape(menuTreeReducer(tree(), { type: "add", items: [item("f")] }))).toBe("a(b,c) d e f")
    expect(shape(menuTreeReducer(tree(), { type: "remove", key: "b" }))).toBe("a(c) d e")
    expect(shape(menuTreeReducer(tree(), { type: "remove", key: "a" }))).toBe("b c d e")
    expect(shape(menuTreeReducer(tree(), { type: "remove", key: "zz" }))).toBe("a(b,c) d e")
  })

  it("moves up and down among siblings only", () => {
    expect(shape(menuTreeReducer(tree(), { type: "moveDown", key: "a" }))).toBe("d a(b,c) e")
    expect(shape(menuTreeReducer(tree(), { type: "moveUp", key: "c" }))).toBe("a(c,b) d e")
    expect(shape(menuTreeReducer(tree(), { type: "moveUp", key: "a" }))).toBe("a(b,c) d e")
    expect(shape(menuTreeReducer(tree(), { type: "moveDown", key: "c" }))).toBe("a(b,c) d e")
  })

  it("nests under the item above and moves out to just after the parent", () => {
    expect(shape(menuTreeReducer(tree(), { type: "indent", key: "d" }))).toBe("a(b,c,d) e")
    expect(shape(menuTreeReducer(tree(), { type: "indent", key: "e" }))).toBe("a(b,c) d(e)")
    expect(shape(menuTreeReducer(tree(), { type: "outdent", key: "b" }))).toBe("a(c) b d e")
    // One level only: a parent can't be nested, nor can the first item or a child.
    const withParent = [item("x"), item("a", [item("b")])]
    expect(shape(menuTreeReducer(withParent, { type: "indent", key: "a" }))).toBe("x a(b)")
    expect(shape(menuTreeReducer(tree(), { type: "indent", key: "a" }))).toBe("a(b,c) d e")
    expect(shape(menuTreeReducer(tree(), { type: "indent", key: "b" }))).toBe("a(b,c) d e")
    expect(shape(menuTreeReducer(tree(), { type: "outdent", key: "d" }))).toBe("a(b,c) d e")
  })

  it("drops before, after or inside, within the one-level rule", () => {
    expect(shape(menuTreeReducer(tree(), { type: "drop", key: "e", target: "a", position: "before" }))).toBe("e a(b,c) d")
    expect(shape(menuTreeReducer(tree(), { type: "drop", key: "e", target: "b", position: "after" }))).toBe("a(b,e,c) d")
    expect(shape(menuTreeReducer(tree(), { type: "drop", key: "d", target: "e", position: "inside" }))).toBe("a(b,c) e(d)")
    expect(shape(menuTreeReducer(tree(), { type: "drop", key: "c", target: "e", position: "after" }))).toBe("a(b) d e c")
    expect(shape(menuTreeReducer(tree(), { type: "drop", key: "a", target: "e", position: "after" }))).toBe("d e a(b,c)")
    // Refused: a parent into or beside a child, onto itself, into its own child.
    for (const [key, target, position] of [
      ["a", "e", "inside"],
      ["a", "b", "after"],
      ["a", "a", "before"],
      ["b", "c", "inside"],
      ["a", "c", "before"],
    ] as const) {
      expect(canDrop(tree(), key, target, position)).toBe(false)
      expect(shape(menuTreeReducer(tree(), { type: "drop", key, target, position }))).toBe("a(b,c) d e")
    }
  })

  it("edits a label, and a custom link's URL", () => {
    const edited = menuTreeReducer(tree(), { type: "edit", key: "c", label: "Contact", url: "/contact" })
    expect(edited[0].children[1]).toMatchObject({ label: "Contact", url: "/contact", href: "/contact" })
    const post = { ...item("p"), type: "post" as const, url: undefined, targetId: 1 }
    expect(menuTreeReducer([post], { type: "edit", key: "p", url: "/x" })[0].url).toBeUndefined()
  })

  it("offers the moves that apply and says where an item is", () => {
    expect(availableMoves(tree(), "a")).toEqual({ up: false, down: true, indent: false, outdent: false })
    expect(availableMoves(tree(), "d")).toEqual({ up: true, down: true, indent: true, outdent: false })
    expect(availableMoves(tree(), "c")).toEqual({ up: true, down: false, indent: false, outdent: true })
    expect(describePlace(tree(), "c")).toBe("C: under A, 2 of 2")
    expect(describePlace(tree(), "e")).toBe("E: top level, 3 of 3")
  })
})
