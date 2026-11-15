/**
 * Pure helpers for author bylines, "Written by" cards and the author page (#350).
 * Tested in authors.test.ts.
 */

// Who a byline credits is core's (src/lib/bylines.ts), shared with the post_byline site block
// (#489), so a block template and this theme credit the same people the same way.
export { bylinePeople, displayName, nameSeparator, type BylinePerson } from "@/lib/bylines"

// The website as a link target, only for an absolute http(s) URL (the API checks
// this too; this keeps a bad stored value from becoming a javascript: link).
export function safeWebsite(website: string | undefined | null): string | null {
  const value = (website ?? "").trim()
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null
  } catch {
    return null
  }
}

// The website as link text: host and path, without the scheme, "www." or a trailing
// slash ("https://www.anacosta.example/" → "anacosta.example").
export function websiteLabel(href: string): string {
  const url = new URL(href)
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")
  return `${url.host.replace(/^www\./, "")}${path}`
}

export function postCountLabel(n: number): string {
  return n === 1 ? "1 post" : `${n} posts`
}
