import { describe, expect, it } from "vitest"
import { buildPageTree, type TreePage } from "./pageTree"

// The Pages list's tree (#340): post_parent nesting, menu_order between siblings, and
// pages whose parent isn't there.

const page = (id: number, title: string, post_parent: number | null = null, menu_order = 0): TreePage => ({
  id,
  title,
  post_parent,
  menu_order,
})

const outline = (pages: TreePage[]) =>
  buildPageTree(pages).map((r) => `${"  ".repeat(r.depth)}${r.page.title}${r.orphan ? " (orphan)" : ""}`)

describe("buildPageTree", () => {
  it("puts children right after their parent, by menu_order", () => {
    const pages = [
      page(1, "Home", null, 0),
      page(2, "About", null, 1),
      page(3, "Careers", 2, 2),
      page(4, "Team", 2, 1),
      page(5, "Pricing", null, 2),
      page(6, "Engineering", 3, 0),
    ]
    expect(outline(pages)).toEqual(["Home", "About", "  Team", "  Careers", "    Engineering", "Pricing"])
  })

  it("breaks menu_order ties by title, then by id", () => {
    const pages = [page(9, "Terms", null, 5), page(8, "Privacy", null, 5), page(7, "Privacy", null, 5), page(6, "Contact", null, 4)]
    expect(buildPageTree(pages).map((r) => r.page.id)).toEqual([6, 7, 8, 9])
  })

  it("treats post_parent 0 like no parent", () => {
    expect(outline([page(1, "Home", 0)])).toEqual(["Home"])
  })

  it("lifts a page whose parent isn't in the list to the top, marked as an orphan", () => {
    // Team's parent (About, id 2) was filtered out or deleted.
    const pages = [page(1, "Home", null, 0), page(4, "Team", 2, 1), page(5, "Zebra", 2, 0), page(6, "Lead", 4, 0)]
    expect(outline(pages)).toEqual(["Home", "Zebra (orphan)", "Team (orphan)", "  Lead"])
  })

  it("sorts orphans among the top-level pages by menu_order", () => {
    const pages = [page(1, "A", null, 2), page(2, "B", 99, 1), page(3, "C", null, 0)]
    expect(outline(pages)).toEqual(["C", "B (orphan)", "A"])
  })

  it("treats a page that is its own parent as an orphan", () => {
    expect(outline([page(1, "Loop", 1)])).toEqual(["Loop (orphan)"])
  })

  it("shows every page of a parent loop once", () => {
    const pages = [page(1, "Root", null), page(2, "B", 3, 0), page(3, "A", 2, 0), page(4, "Child of A", 3, 0)]
    const rows = buildPageTree(pages)
    expect(rows.map((r) => r.page.id).sort()).toEqual([1, 2, 3, 4])
    expect(outline(pages)).toEqual(["Root", "A (orphan)", "  B", "  Child of A"])
  })

  it("returns nothing for no pages", () => {
    expect(buildPageTree([])).toEqual([])
  })
})
