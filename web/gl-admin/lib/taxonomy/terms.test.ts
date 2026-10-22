import { describe, expect, it } from "vitest"
import type { TaxonomyTerm } from "@gl-admin/lib/api/types"
import {
  childCount,
  deleteConsequences,
  findTermByName,
  flattenTermTree,
  parentOptions,
  parseTagNames,
  slugify,
  subtreeIds,
  toggleId,
} from "./terms"

const term = (id: number, name: string, parent_id?: number, post_count = 0): TaxonomyTerm => ({
  id,
  name,
  slug: name.toLowerCase(),
  description: "",
  parent_id,
  taxonomy_type_id: 1,
  post_count,
  created_at: "2026-10-22T00:00:00Z",
})

// News > World > Europe, News > Sport; Arts is a root
const news = term(1, "News")
const world = term(2, "World", 1)
const europe = term(3, "Europe", 2)
const sport = term(4, "Sport", 1)
const arts = term(5, "Arts")
const all = [europe, sport, news, arts, world]

const shape = (nodes: { term: TaxonomyTerm; depth: number }[]) => nodes.map((n) => `${"-".repeat(n.depth)}${n.term.name}`)

describe("flattenTermTree", () => {
  it("puts children under their parent, A-Z at each level", () => {
    expect(shape(flattenTermTree(all))).toEqual(["Arts", "News", "-Sport", "-World", "--Europe"])
  })

  it("shows a term whose parent is missing at the top level", () => {
    expect(shape(flattenTermTree([europe, arts]))).toEqual(["Arts", "Europe"])
  })

  it("keeps terms that only form a cycle instead of dropping them", () => {
    const a = term(10, "A", 11)
    const b = term(11, "B", 10)
    const self = term(12, "Self", 12)
    const nodes = flattenTermTree([a, b, self])
    expect(nodes.map((n) => n.term.id).sort()).toEqual([10, 11, 12])
    expect(shape(nodes)).toEqual(["Self", "A", "-B"])
  })
})

describe("parent choices", () => {
  it("collects a term's whole subtree", () => {
    expect([...subtreeIds(all, 1)].sort()).toEqual([1, 2, 3, 4])
    expect([...subtreeIds(all, 2)].sort()).toEqual([2, 3])
  })

  it("never offers the term itself or its descendants as a parent", () => {
    expect(parentOptions(all, 2).map((n) => n.term.name)).toEqual(["Arts", "News", "Sport"])
  })

  it("offers every term when creating", () => {
    expect(parentOptions(all)).toHaveLength(all.length)
  })

  it("counts direct children only", () => {
    expect(childCount(all, 1)).toBe(2)
    expect(childCount(all, 3)).toBe(0)
  })
})

describe("deleteConsequences", () => {
  it("warns about posts and child terms", () => {
    expect(deleteConsequences(term(1, "News", undefined, 3), 2)).toEqual([
      "It is assigned to 3 posts. Deleting it removes it from those posts.",
      "2 child terms move to the top level.",
    ])
  })

  it("uses the singular for one post or child", () => {
    expect(deleteConsequences(term(1, "News", undefined, 1), 1)).toEqual([
      "It is assigned to 1 post. Deleting it removes it from that post.",
      "1 child term moves to the top level.",
    ])
  })

  it("says so when nothing uses the term", () => {
    expect(deleteConsequences(term(1, "News"), 0)).toEqual(["No posts use it."])
  })
})

describe("tag input helpers", () => {
  it("splits, trims and de-duplicates tag names", () => {
    expect(parseTagNames("News, go ,news,, Go ")).toEqual(["News", "go"])
    expect(parseTagNames("  ")).toEqual([])
  })

  it("finds an existing term by name ignoring case and spaces", () => {
    expect(findTermByName(all, "  europe ")).toBe(europe)
    expect(findTermByName(all, "Asia")).toBeUndefined()
  })

  it("toggles ids without duplicating them", () => {
    expect(toggleId([1, 2], 3, true)).toEqual([1, 2, 3])
    expect(toggleId([1, 2], 2, true)).toEqual([1, 2])
    expect(toggleId([1, 2], 1, false)).toEqual([2])
  })
})

describe("slugify", () => {
  it("matches the API's generateSlug rules", () => {
    expect(slugify("Technology News")).toBe("technology-news")
    expect(slugify("Go_Programming  Guide")).toBe("go-programming-guide")
    expect(slugify("  Multiple   Spaces  ")).toBe("multiple-spaces")
    expect(slugify("São Paulo--Brazil")).toBe("são-paulo-brazil")
  })
})
