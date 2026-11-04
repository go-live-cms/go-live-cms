/**
 * The post settings' Authors field (#319): the byline's rules, kept pure so they're
 * tested (postAuthors.test.ts). The API checks the same limits (posts_authors.go).
 */
import type { PostAuthor } from "@gl-admin/lib/api/types"
import type { SelectOption } from "@gl-admin/components/ui/Select"

// PUT /posts/:id/authors takes 1–20 users.
export const MAX_POST_AUTHORS = 20

export const AUTHORS_HINT = "Byline shown on the published post. Adding an author doesn’t give them access."
export const AUTHORS_PENDING_HINT = "The site shows the published byline until you update."

export function authorName(author: Pick<PostAuthor, "username" | "full_name">): string {
  return author.full_name?.trim() || author.username
}

// Adds `author` at the end. Already credited, or the byline is full: unchanged.
export function addAuthor(list: PostAuthor[], author: PostAuthor): PostAuthor[] {
  if (list.some((a) => a.id === author.id) || list.length >= MAX_POST_AUTHORS) return list
  return [...list, author]
}

// A byline always credits someone, so the last author can't be removed.
export function canRemoveAuthor(list: PostAuthor[]): boolean {
  return list.length > 1
}

export function removeAuthor(list: PostAuthor[], id: number): PostAuthor[] {
  if (!canRemoveAuthor(list)) return list
  return list.filter((a) => a.id !== id)
}

// Moves the author one place earlier (-1) or later (+1); at an end it stays.
export function moveAuthor(list: PostAuthor[], id: number, delta: -1 | 1): PostAuthor[] {
  const from = list.findIndex((a) => a.id === id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= list.length) return list
  const next = [...list]
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

export function canMoveAuthor(list: PostAuthor[], id: number, delta: -1 | 1): boolean {
  const from = list.findIndex((a) => a.id === id)
  return from >= 0 && from + delta >= 0 && from + delta < list.length
}

export function authorIds(list: PostAuthor[]): number[] {
  return list.map((a) => a.id)
}

// The picker's options: candidates not already credited, "Name" with the username
// as the second line.
export function candidateOptions(candidates: PostAuthor[], list: PostAuthor[]): SelectOption[] {
  const credited = new Set(list.map((a) => a.id))
  return candidates
    .filter((c) => !credited.has(c.id))
    .map((c) => ({ value: String(c.id), label: authorName(c), description: `@${c.username}` }))
}

// "Ana Costa and Luan" / "Ana, Bo and 2 others": the field's summary for screen readers.
export function bylineSummary(list: PostAuthor[]): string {
  const names = list.map(authorName)
  if (names.length <= 1) return names[0] ?? ""
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`
}
