/**
 * Bylines on the public site: who is credited, how each name links and the avatar's colour.
 * Pure and browser-safe. The default theme's components (#345, #350) and the `post_byline`
 * site block (#489) both read these, so a block template and a code layout credit the same
 * people the same way; `themes/default/lib/authors.ts` and `avatar.ts` re-export them.
 */
import type { Post } from "@gl-admin/lib/api/types"
import { safeAvatarSrc } from "@gl-admin/lib/presence"
import { authorPath } from "./seo"

/** The avatars' colours. They carry white text, so each keeps 4.5:1 against #ffffff (the theme's tokens.test.ts). */
export const AVATAR_COLORS = ["#6550b9", "#2a7e3b", "#a1305a", "#0b68b8", "#9a4a12", "#5b5a55"]

// Keyed by username (#350): the public author profile has no id, and an author's colour must
// match between bylines, "Written by" cards and their page. A number (an owner's id when a post
// has no byline) still works.
export function avatarColor(key: number | string | undefined): string {
  let n = 0
  if (typeof key === "string") {
    for (const ch of key) n = (n * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  } else if (Number.isInteger(key)) {
    n = Math.abs(key as number)
  }
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}

export function initial(name: string | undefined): string {
  const ch = (name ?? "").trim().charAt(0)
  return ch ? ch.toUpperCase() : "?"
}

export interface BylinePerson {
  name: string
  // Avatar colour key: always the username, so a person keeps one colour everywhere.
  key: string
  // The author page, for credited authors only (they're the ones with a page).
  href?: string
  // Their uploaded picture (#334), checked by safeAvatarSrc; null shows the initial.
  avatar?: string | null
}

type Credited = { username: string; full_name?: string; avatar?: string | null }

export function displayName(author: Credited): string {
  return author.full_name?.trim() || author.username
}

// People in a byline: the credited authors when there are any (each links to their page),
// else the post's owner, who may have no page and so isn't linked.
export function bylinePeople(credited: Credited[] | undefined, owner: { user_id?: number; username?: string }): BylinePerson[] {
  if (credited && credited.length > 0) {
    return credited.map((a) => {
      const avatar = safeAvatarSrc(a.avatar)
      return { name: displayName(a), key: a.username, href: authorPath(a.username), ...(avatar ? { avatar } : {}) }
    })
  }
  return owner.username ? [{ name: owner.username, key: owner.username }] : []
}

// Names for a list row's byline (#351's "More to read"): every credited author when the API
// sent them, else the post's owner.
export function authorNames(post: Pick<Post, "authors" | "username">): string[] {
  const names = (post.authors ?? []).map((a) => a.full_name?.trim() || a.username).filter(Boolean)
  return names.length > 0 ? names : post.username ? [post.username] : []
}

// "Ana", "Ana and Luan", "Ana, Luan and Priya"
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

// What goes before the i-th of n names: "", ", " or " and " ("Ana, Luan and Priya").
export function nameSeparator(i: number, n: number): string {
  if (i === 0) return ""
  return i === n - 1 ? " and " : ", "
}
