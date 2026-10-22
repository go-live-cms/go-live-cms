import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../api", () => ({ apiCall: vi.fn() }))

import { apiCall } from "../api"
import {
  addPostTaxonomyTerm,
  deleteTaxonomyTerm,
  getAllTaxonomyTerms,
  getPostTaxonomyTerms,
  getTaxonomyTypes,
  removePostTaxonomyTerm,
  updateTaxonomyTerm,
} from "./taxonomies"

const mockedApiCall = vi.mocked(apiCall)

const terms = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: from + i, name: `T${from + i}`, slug: `t${from + i}` }))

beforeEach(() => {
  mockedApiCall.mockReset()
})

// The routes live under /taxonomy/... (api/taxonomy_routes.go); the client used
// to call /taxonomy-types and /taxonomy-terms, which don't exist (#167).
describe("taxonomies API client", () => {
  it("lists types from /taxonomy/types and fills in a total", async () => {
    mockedApiCall.mockResolvedValue({ taxonomy_types: [{ id: 1 }, { id: 2 }], meta: { count: 2 } })
    const result = await getTaxonomyTypes()
    expect(mockedApiCall).toHaveBeenCalledWith("/taxonomy/types")
    expect(result.meta.total).toBe(2)
  })

  it("follows pages until it has every term of a type", async () => {
    mockedApiCall
      .mockResolvedValueOnce({ taxonomy_terms: terms(1, 100), meta: { total: 150 } })
      .mockResolvedValueOnce({ taxonomy_terms: terms(101, 50), meta: { total: 150 } })

    const all = await getAllTaxonomyTerms("category")

    expect(all).toHaveLength(150)
    expect(mockedApiCall.mock.calls.map((c) => c[0])).toEqual([
      "/taxonomy/types/category/terms?limit=100&offset=0&sort=name_asc",
      "/taxonomy/types/category/terms?limit=100&offset=100&sort=name_asc",
    ])
  })

  it("stops on an empty page even if the total says otherwise", async () => {
    mockedApiCall.mockResolvedValueOnce({ taxonomy_terms: [], meta: { total: 5 } })
    expect(await getAllTaxonomyTerms("tag")).toEqual([])
    expect(mockedApiCall).toHaveBeenCalledTimes(1)
  })

  it("updates and force-deletes terms under /taxonomy/terms", async () => {
    mockedApiCall.mockResolvedValue({})
    await updateTaxonomyTerm(7, { name: "News", parent_id: 0 })
    await deleteTaxonomyTerm(7, true)
    expect(mockedApiCall.mock.calls).toEqual([
      ["/taxonomy/terms/7", { method: "PUT", body: { name: "News", parent_id: 0 }, token: undefined }],
      ["/taxonomy/terms/7?force=true", { method: "DELETE", token: undefined }],
    ])
  })

  it("reads a post's terms and changes them one at a time", async () => {
    mockedApiCall.mockResolvedValueOnce({ taxonomy_terms: terms(1, 2) }).mockResolvedValue({})
    expect(await getPostTaxonomyTerms(42)).toHaveLength(2)
    await addPostTaxonomyTerm(42, 7)
    await removePostTaxonomyTerm(42, 8)
    // Never the whole set: a concurrent editor's other terms stay untouched
    expect(mockedApiCall.mock.calls).toEqual([
      ["/posts/42/taxonomy-terms"],
      ["/posts/42/taxonomy-terms/7", { method: "PUT" }],
      ["/posts/42/taxonomy-terms/8", { method: "DELETE" }],
    ])
  })
})
