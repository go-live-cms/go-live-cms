import type { TaxonomyType, TaxonomyTerm, TaxonomySortOption, PaginationParams, ApiResponse } from "./types"
import { apiCall } from "../api"
import { buildUrl } from "./utils"

export interface TaxonomyTermQueryParams extends PaginationParams {
  sort?: TaxonomySortOption
  type?: string // taxonomy type name
  q?: string // search query
  status?: string
}

export async function getTaxonomyTypes(): Promise<ApiResponse<TaxonomyType>> {
  const response = await apiCall("/taxonomy-types")
  return {
    data: response.taxonomy_types || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

export async function getTaxonomyTypeByName(name: string): Promise<{ taxonomy_type: TaxonomyType }> {
  return apiCall(`/taxonomy-types/${name}`)
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
  return apiCall("/taxonomy-types", { method: "POST", body: data, token })
}

export async function getTaxonomyTerms(params: {
  type: string
  limit?: number
  offset?: number
  sort?: TaxonomySortOption
  parent_id?: number | null
  search?: string
}): Promise<ApiResponse<TaxonomyTerm>> {
  const { type, ...queryParams } = params
  const url = buildUrl(`/taxonomy-terms/type/${type}`, queryParams)
  const response = await apiCall(url)
  return {
    data: response.taxonomy_terms || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

export async function searchTaxonomyTerms(params: {
  type: string
  q: string
  limit?: number
  offset?: number
}): Promise<ApiResponse<TaxonomyTerm>> {
  const url = buildUrl("/taxonomy-terms/search", params)
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
  const url = buildUrl("/taxonomy-terms/popular", params)
  const response = await apiCall(url)
  return {
    data: response.taxonomy_terms || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

export async function getTaxonomyTermById(id: string | number): Promise<{ taxonomy_term: TaxonomyTerm }> {
  return apiCall(`/taxonomy-terms/${id}`)
}

export async function getTaxonomyTermBySlug(slug: string): Promise<{ taxonomy_term: TaxonomyTerm }> {
  return apiCall(`/taxonomy-terms/slug/${slug}`)
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
): Promise<any> {
  return apiCall("/taxonomy-terms", { method: "POST", body: data, token })
}

export async function updateTaxonomyTerm(
  id: string | number,
  data: {
    name?: string
    slug?: string
    description?: string
    parent_id?: number
    sort_order?: number
    meta?: Record<string, any>
  },
  token?: string
): Promise<any> {
  return apiCall(`/taxonomy-terms/${id}`, { method: "PUT", body: data, token })
}

export async function deleteTaxonomyTerm(id: string | number, force?: boolean, token?: string): Promise<any> {
  const query = force ? "?force=true" : ""
  return apiCall(`/taxonomy-terms/${id}${query}`, { method: "DELETE", token })
}
