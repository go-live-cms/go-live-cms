/**
 * Pure helpers for author bylines, "Written by" cards and the author page (#350).
 * Tested in authors.test.ts.
 */
import { authorPath } from "@/lib/seo"

export interface BylinePerson {
  name: string
  // Avatar colour key: the username when we know it, else the owner's id.
  key: string | number
  // The author page, for credited authors only (they're the ones with a page).
  href?: string
}

type Credited = { username: string; full_name?: string }

export function displayName(author: Credited): string {
  return author.full_name?.trim() || author.username
}

// People in a byline: the credited authors when there are any (each links to their
// page), else the post's owner, who may have no page and so isn't linked.
export function bylinePeople(
  credited: Credited[] | undefined,
  owner: { user_id?: number; username?: string },
): BylinePerson[] {
  if (credited && credited.length > 0) {
    return credited.map((a) => ({ name: displayName(a), key: a.username, href: authorPath(a.username) }))
  }
  return owner.username ? [{ name: owner.username, key: owner.user_id ?? owner.username }] : []
}

// What goes before the i-th of n names: "", ", " or " and " ("Ana, Luan and Priya").
export function nameSeparator(i: number, n: number): string {
  if (i === 0) return ""
  return i === n - 1 ? " and " : ", "
}

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
