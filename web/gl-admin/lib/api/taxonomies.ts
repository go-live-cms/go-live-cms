import type { TaxonomyType, TaxonomyTerm, TaxonomySortOption, PaginationParams, ApiResponse } from "./types"
import { apiCall } from "../api"
import { buildUrl } from "./utils"

// Routes live under /taxonomy/types and /taxonomy/terms (api/taxonomy_routes.go).
// Reads are public; writes need an admin or editor (requireContentEditor).

export interface TaxonomyTermQueryParams extends PaginationParams {
  sort?: TaxonomySortOption
  type?: string // taxonomy type name
  q?: string // search query
  status?: string
}

export async function getTaxonomyTypes(): Promise<ApiResponse<TaxonomyType>> {
  const response = await apiCall("/taxonomy/types")
  const data: TaxonomyType[] = response.taxonomy_types || []
  // The types endpoint isn't paginated: its meta only has a count.
  return {
    data,
    meta: { count: data.length, limit: data.length, offset: 0, total: data.length },
  }
}

export async function getTaxonomyTypeByName(name: string): Promise<{ taxonomy_type: TaxonomyType }> {
  return apiCall(`/taxonomy/types/${encodeURIComponent(name)}`)
}

export async function createTaxonomyType(
  data: {
    name: string
    label: string
    description?: string
    hierarchical?: boolean
    public?: boolean
    show_ui?: boolean
    show_in_menu?: boolean
  },
  token?: string
): Promise<any> {
  return apiCall("/taxonomy/types", { method: "POST", body: data, token })
}

export async function getTaxonomyTerms(params: {
  type: string
  limit?: number
  offset?: number
  sort?: TaxonomySortOption
}): Promise<ApiResponse<TaxonomyTerm>> {
  const { type, ...queryParams } = params
  const url = buildUrl(`/taxonomy/types/${encodeURIComponent(type)}/terms`, queryParams)
  const response = await apiCall(url)
  return {
    data: response.taxonomy_terms || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

// The API caps a page at 100 terms.
const TERMS_PAGE_SIZE = 100

// Every term of a type, following pages. The admin builds the parent/child tree
// client-side, so it needs the whole list rather than one page of it.
export async function getAllTaxonomyTerms(type: string): Promise<TaxonomyTerm[]> {
  const terms: TaxonomyTerm[] = []
  for (;;) {
    const page = await getTaxonomyTerms({ type, limit: TERMS_PAGE_SIZE, offset: terms.length, sort: "name_asc" })
    terms.push(...page.data)
    const total = page.meta.total ?? terms.length
    if (page.data.length === 0 || terms.length >= total) return terms
  }
}

export async function searchTaxonomyTerms(params: {
  type: string
  q: string
  limit?: number
  offset?: number
}): Promise<ApiResponse<TaxonomyTerm>> {
  const url = buildUrl("/taxonomy/terms/search", params)
  const response = await apiCall(url)
  return {
    data: response.taxonomy_terms || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

export async function getPopularTaxonomyTerms(params: {
  type: string
  limit?: number
}): Promise<ApiResponse<TaxonomyTerm>> {
  const url = buildUrl("/taxonomy/terms/popular", params)
  const response = await apiCall(url)
  return {
    data: response.taxonomy_terms || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

export async function getTaxonomyTermById(id: string | number): Promise<{ taxonomy_term: TaxonomyTerm }> {
  return apiCall(`/taxonomy/terms/${id}`)
}

export async function getTaxonomyTermBySlug(slug: string): Promise<{ taxonomy_term: TaxonomyTerm }> {
  return apiCall(`/taxonomy/terms/slug/${encodeURIComponent(slug)}`)
}

export async function createTaxonomyTerm(
  data: {
    name: string
    slug?: string
    description?: string
    taxonomy_type_id: number
    parent_id?: number
    sort_order?: number
    meta?: Record<string, any>
  },
  token?: string
): Promise<{ taxonomy_term: TaxonomyTerm }> {
  return apiCall("/taxonomy/terms", { method: "POST", body: data, token })
}

export async function updateTaxonomyTerm(
  id: string | number,
  data: {
    name?: string
    slug?: string
    description?: string
    // 0 moves the term to the top level
    parent_id?: number
    sort_order?: number
    meta?: Record<string, any>
  },
  token?: string
): Promise<{ taxonomy_term: TaxonomyTerm }> {
  return apiCall(`/taxonomy/terms/${id}`, { method: "PUT", body: data, token })
}

// Without force the API answers 409 if posts use the term; with it, the term is
// removed from those posts too. Child terms move to the top level.
export async function deleteTaxonomyTerm(id: string | number, force?: boolean, token?: string): Promise<any> {
  const query = force ? "?force=true" : ""
  return apiCall(`/taxonomy/terms/${id}${query}`, { method: "DELETE", token })
}

export async function getPostTaxonomyTerms(postId: string | number): Promise<TaxonomyTerm[]> {
  const response = await apiCall(`/posts/${postId}/taxonomy-terms`)
  return response.taxonomy_terms || []
}

// One term at a time (idempotent), so editors changing different terms of the
// same post don't overwrite each other.
export async function addPostTaxonomyTerm(postId: string | number, termId: number): Promise<void> {
  await apiCall(`/posts/${postId}/taxonomy-terms/${termId}`, { method: "PUT" })
}

export async function removePostTaxonomyTerm(postId: string | number, termId: number): Promise<void> {
  await apiCall(`/posts/${postId}/taxonomy-terms/${termId}`, { method: "DELETE" })
}
