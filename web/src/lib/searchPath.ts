/**
 * The search page's address and the longest query it reads (#145), with no imports, so a
 * block renderer (the search block, #488) can use them without pulling the search page's
 * data code into the admin's bundle. `search.ts` re-exports both.
 */
export const SEARCH_PATH = "/search"

export const MAX_QUERY_LENGTH = 200