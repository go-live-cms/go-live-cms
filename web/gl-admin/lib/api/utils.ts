/**
 * Utility functions for API operations
 */

/**
 * Builds a query string from an object, filtering out undefined, null, and empty string values
 * @param params - Object containing query parameters
 * @returns URL-encoded query string (without leading ?)
 */
export function buildQueryString(params: Record<string, any>): string {
  const filtered = Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null && v !== "")
    .reduce((acc, [k, v]) => {
      acc[k] = String(v)
      return acc
    }, {} as Record<string, string>)

  return new URLSearchParams(filtered).toString()
}

/**
 * Builds a complete URL with query string if parameters exist
 * @param basePath - The base URL path
 * @param params - Query parameters object
 * @returns Complete URL with query string if params exist
 */
export function buildUrl(basePath: string, params: Record<string, any> = {}): string {
  const queryString = buildQueryString(params)
  return queryString ? `${basePath}?${queryString}` : basePath
}
