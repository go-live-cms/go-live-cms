import { describe, expect, it } from "vitest"
import { ApiError } from "./api/errors"
import type { TaxonomyTerm } from "./api/types"
import {
  defaultKeep,
  isDefaultTerm,
  joinNames,
  mergeSummary,
  parentHint,
  slugChangeNote,
  slugHint,
  slugPrefix,
  taxonomyIntro,
  termErrorMessage,
  termParentOptions,
} from "./taxonomyAdmin"
import { bulkDeleteConsequences, deleteConsequences } from "./taxonomy/terms"

// Taxonomies (#331): one category per post, nested one level, in post URLs; tag merges.

const term = (id: number, name: string, parent_id?: number, post_count = 0): TaxonomyTerm => ({
  id,
  name,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  description: "",
  parent_id,
  taxonomy_type_id: 1,
  post_count,
  created_at: "",
})

const category = { name: "category", label: "Categories", hierarchical: true, public: true, default_term_id: 9, description: "" }
const tag = { name: "tag", label: "Tags", hierarchical: false, public: true, default_term_id: null, description: "" }
const topics = { name: "topic", label: "Topics", hierarchical: true, public: true, description: "Deep tree" }

const CATS = [term(1, "Product updates", undefined, 14), term(2, "Changelog", 1, 6), term(4, "Guides", undefined, 11), term(9, "Uncategorized", undefined, 2)]

describe("the parent picker", () => {
  it("offers top-level categories other than itself", () => {
    expect(termParentOptions(category, CATS, 4).map((n) => n.term.name)).toEqual(["Product updates", "Uncategorized"])
    expect(termParentOptions(category, CATS).map((n) => n.term.name)).toEqual(["Guides", "Product updates", "Uncategorized"])
    // A child can move under another top-level category, never under a child
    expect(termParentOptions(category, CATS, 2).map((n) => n.term.name)).toEqual(["Guides", "Product updates", "Uncategorized"])
  })

  it("offers none to a category with subcategories, and says why", () => {
    expect(termParentOptions(category, CATS, 1)).toEqual([])
    expect(parentHint(category, CATS, CATS[0])).toBe("“Product updates” has subcategories, so it stays at the top level.")
    expect(parentHint(category, CATS, CATS[2])).toBeUndefined()
  })

  it("keeps any depth for other hierarchical types", () => {
    const terms = [term(1, "A"), term(2, "B", 1), term(3, "C", 2)]
    expect(termParentOptions(topics, terms, 3).map((n) => n.term.name)).toEqual(["A", "B"])
    expect(parentHint(topics, terms, terms[0])).toBeUndefined()
  })
})

it("knows the default category", () => {
  expect(isDefaultTerm(category, CATS[3])).toBe(true)
  expect(isDefaultTerm(category, CATS[0])).toBe(false)
  expect(isDefaultTerm(tag, term(1, "x"))).toBe(false)
  expect(isDefaultTerm({}, CATS[3])).toBe(false)
})

it("introduces categories with their rules", () => {
  expect(taxonomyIntro(category, "category")).toBe("Each post has one category. Categories can be nested one level and appear in the post’s URL.")
  expect(taxonomyIntro(category, "slug")).toBe("Each post has one category. Categories can be nested one level.")
  expect(taxonomyIntro(topics, "slug")).toBe("Deep tree")
})

describe("the slug", () => {
  it("shows where it appears in addresses", () => {
    expect(slugPrefix(category, "category")).toBe("/")
    expect(slugPrefix(category, "slug")).toBe("/category/")
    expect(slugPrefix(tag, "category")).toBe("/tag/")
    expect(slugPrefix({ ...tag, public: false }, "slug")).toBeNull()
  })

  it("notes the post URLs a category slug change updates, under the category structure", () => {
    const guides = CATS[2]
    expect(slugChangeNote(category, guides, "how-to", "Guides", "category")).toBe("Changing it updates 11 post URLs. Old links redirect.")
    expect(slugChangeNote(category, { ...guides, post_count: 1 }, "how-to", "Guides", "category")).toBe(
      "Changing it updates 1 post URL. Old links redirect."
    )
    expect(slugChangeNote(category, { ...guides, post_count: 0 }, "how-to", "Guides", "category")).toBe("Old links redirect.")
    expect(slugChangeNote(category, guides, "how-to", "Guides", "slug")).toBe("Old links redirect.")
    expect(slugChangeNote(tag, guides, "how-to", "Guides", "category")).toBe("Old links redirect.")
  })

  it("says nothing until the slug really changes, or for a new term", () => {
    const guides = CATS[2]
    expect(slugChangeNote(category, guides, "guides", "Guides", "category")).toBeNull()
    expect(slugChangeNote(category, guides, " Guides ", "Guides", "category")).toBeNull()
    // Empty = the name's slug, the same one
    expect(slugChangeNote(category, guides, "", "Guides", "category")).toBeNull()
    expect(slugChangeNote(category, guides, "", "How to", "category")).toBe("Changing it updates 11 post URLs. Old links redirect.")
    expect(slugChangeNote(category, undefined, "x", "X", "category")).toBeNull()
    expect(slugChangeNote({ ...category, public: false }, guides, "x", "X", "category")).toBeNull()
  })

  it("combines how the slug is saved with the note", () => {
    const guides = CATS[2]
    expect(slugHint(category, undefined, "", "New One", "slug")).toBe("Leave empty to use “new-one”.")
    expect(slugHint(category, guides, "Step By Step", "Guides", "slug")).toBe("Saved as “step-by-step”. Old links redirect.")
    expect(slugHint(category, guides, "guides", "Guides", "slug")).toBeUndefined()
  })
})

describe("merging tags", () => {
  const photos = term(7, "Photos", undefined, 3)
  const images = term(5, "Images", undefined, 5)
  const pics = term(8, "Pics", undefined, 1)

  it("keeps the tag on the most posts by default", () => {
    expect(defaultKeep([photos, images])?.name).toBe("Images")
    expect(defaultKeep([term(1, "B", undefined, 2), term(2, "A", undefined, 2)])?.name).toBe("A")
  })

  it("reads like the board for one tag", () => {
    expect(mergeSummary(tag, images, [photos])).toBe(
      "The 3 posts tagged Photos get Images instead, and Photos is deleted. /tag/photos redirects to /tag/images."
    )
    expect(mergeSummary(tag, images, [pics])).toBe("The post tagged Pics gets Images instead, and Pics is deleted. /tag/pics redirects to /tag/images.")
    expect(mergeSummary(tag, images, [term(3, "Empty")])).toBe("No posts are tagged Empty. Empty is deleted. /tag/empty redirects to /tag/images.")
  })

  it("reads in the plural for several", () => {
    expect(mergeSummary(tag, images, [photos, pics])).toBe(
      "The 4 posts tagged Photos or Pics get Images instead, and Photos and Pics are deleted. /tag/photos and /tag/pics redirect to /tag/images."
    )
    const many = [photos, pics, term(10, "Pix"), term(11, "Shots")]
    expect(mergeSummary(tag, images, many)).toMatch(/and Photos, Pics, Pix and Shots are deleted\. Their old addresses redirect to \/tag\/images\.$/)
  })

  it("has no redirect sentence for a taxonomy without pages", () => {
    expect(mergeSummary({ ...tag, name: "label", public: false }, images, [photos])).toBe(
      "The 3 posts with Photos get Images instead, and Photos is deleted."
    )
  })

  it("joins names", () => {
    expect(joinNames(["A"])).toBe("A")
    expect(joinNames(["A", "B", "C"], "or")).toBe("A, B or C")
  })
})

describe("deleting", () => {
  it("says a category's posts move to the default one", () => {
    expect(deleteConsequences(CATS[2], 0, "Uncategorized")).toEqual(["It is assigned to 11 posts. They move to “Uncategorized”."])
    expect(deleteConsequences({ ...CATS[2], post_count: 1 }, 0, "Uncategorized")).toEqual(["It is assigned to 1 post. That post moves to “Uncategorized”."])
    expect(deleteConsequences(CATS[2], 0)).toEqual(["It is assigned to 11 posts. Deleting it removes it from those posts."])
  })

  it("sums up several tags", () => {
    expect(bulkDeleteConsequences([term(1, "a"), term(2, "b")])).toEqual(["No posts use them."])
    expect(bulkDeleteConsequences([term(1, "a", undefined, 1), term(2, "b", undefined, 2)])).toEqual([
      "Both are assigned to posts. Deleting them removes them from those posts.",
    ])
    expect(bulkDeleteConsequences([term(1, "a", undefined, 1), term(2, "b"), term(3, "c")])).toEqual([
      "1 of them is assigned to posts. Deleting removes it from those posts.",
    ])
  })
})

it("maps the API's codes", () => {
  const err = (code: string) => new ApiError("x", 400, null, code)
  expect(termErrorMessage(err("nesting_too_deep")).field).toBe("parent")
  expect(termErrorMessage(err("slug_reserved")).field).toBe("slug")
  expect(termErrorMessage(err("slug_taken")).field).toBe("slug")
  expect(termErrorMessage(err("default_term"), "delete").message).toMatch(/default category, so it can’t be deleted/)
  expect(termErrorMessage(err("default_term"), "merge").message).toMatch(/can’t be merged/)
  expect(termErrorMessage(err("merge_not_supported")).message).toMatch(/Categories can’t be merged/)
  expect(termErrorMessage(new ApiError("Boom.", 400)).message).toBe("Boom.")
})
