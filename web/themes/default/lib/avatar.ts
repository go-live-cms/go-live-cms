/**
 * Author initials for bylines (#345). The colours carry white text, so each one keeps
 * 4.5:1 against #ffffff (tokens.test.ts).
 */
export const AVATAR_COLORS = ["#6550b9", "#2a7e3b", "#a1305a", "#0b68b8", "#9a4a12", "#5b5a55"]

// Keyed by username (#350): the public author profile has no id, and an author's
// colour must match between bylines, "Written by" cards and their page. A number
// (an owner's id when a post has no byline) still works.
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
