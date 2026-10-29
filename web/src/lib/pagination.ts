/**
 * Numbered pages for the public lists (#349): clean URLs, the page-number window and
 * what a list route does with a request. The API counts and pages the list
 * (`/public/posts/type/:type`, posts_per_page at a time); term (#348), author (#350)
 * and search (#145) lists reuse these with their own base path. Pure, tested in
 * pagination.test.ts; src/components/Pagination.astro renders the pager.
 *
 * URLs: page 1 is the base path itself (`/`, `/post`); page N is `<base>/page/N/`
 * (`/page/2/`, `/post/page/2/`). `?page=N` redirects there.
 */

// What the API sends next to a page of rows (api/pagination.go).
export interface Pagination {
  page: number
  per_page: number
  total: number
  total_pages: number
}

export interface PageLinks {
  newer?: string
  older?: string
}

// One slot of the pager: a page number, or a gap ("…") between two of them.
export type PageSlot = number | "gap"

// The URL of page n of the list at basePath.
export function pagePath(basePath: string, n: number): string {
  const base = basePath.replace(/\/+$/, "")
  return n <= 1 ? base || "/" : `${base}/page/${n}/`
}

// Newer is the page before (lists run newest first), Older the one after.
export function pageLinks(basePath: string, page: number, totalPages: number): PageLinks {
  return {
    newer: page > 1 ? pagePath(basePath, Math.min(page - 1, Math.max(totalPages, 1))) : undefined,
    older: page < totalPages ? pagePath(basePath, page + 1) : undefined,
  }
}

// The page numbers to show: the first and last page, the current one with a
// neighbour each side (three pages at either end, so page 1 of 5 is 1 2 3 … 5, as in
// the design), and a gap for every run of hidden pages.
export function pageWindow(current: number, totalPages: number): PageSlot[] {
  if (totalPages <= 1) return []
  let from = Math.max(1, current - 1)
  let to = Math.min(totalPages, current + 1)
  if (current <= 1) to = Math.min(totalPages, 3)
  if (current >= totalPages) from = Math.max(1, totalPages - 2)

  const shown = new Set<number>([1, totalPages])
  for (let n = from; n <= to; n++) shown.add(n)
  const pages = [...shown].sort((a, b) => a - b)

  const slots: PageSlot[] = []
  pages.forEach((n, i) => {
    if (i > 0 && n - pages[i - 1] > 1) slots.push("gap")
    slots.push(n)
  })
  return slots
}

// The `N` of a `/page/N/` URL: an integer of 1 or more, written without leading
// zeros, else null (the route answers 404).
export function parsePageSegment(segment: string | undefined): number | null {
  if (!segment || !/^[1-9]\d{0,8}$/.test(segment)) return null
  return Number(segment)
}

export type ListRequest =
  | { kind: "page"; page: number }
  | { kind: "redirect"; location: string }
  | { kind: "notFound" }

// What a list route does with a request. `segment` is the N of a `/page/N/` URL
// (undefined on the base path). `?page=` always redirects to the clean URL (other
// query parameters kept), as does `/page/1/`; anything that isn't a page number
// is a 404. Whether page N exists is the API's answer, not decided here.
export function resolveListRequest(url: URL, basePath: string, segment?: string): ListRequest {
  const params = new URLSearchParams(url.search)
  if (params.has("page")) {
    const value = params.get("page") ?? ""
    params.delete("page")
    const fromQuery = parsePageSegment(value.trim())
    const target = segment === undefined ? (fromQuery ?? 1) : parsePageSegment(segment)
    if (target === null) return { kind: "notFound" }
    const query = params.toString()
    return { kind: "redirect", location: `${pagePath(basePath, target)}${query ? `?${query}` : ""}` }
  }
  if (segment === undefined) return { kind: "page", page: 1 }
  const page = parsePageSegment(segment)
  if (page === null) return { kind: "notFound" }
  if (page === 1) {
    return { kind: "redirect", location: `${pagePath(basePath, 1)}${url.search}` }
  }
  return { kind: "page", page }
}

// The title suffix pages after the first get (" · Page 2"), so each has its own title.
export function pageTitleSuffix(page: number): string {
  return page > 1 ? ` · Page ${page}` : ""
}
