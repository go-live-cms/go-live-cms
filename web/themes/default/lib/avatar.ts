/**
 * Author initials for bylines (#345). The colours carry white text, so each one keeps
 * 4.5:1 against #ffffff (tokens.test.ts).
 */
export const AVATAR_COLORS = ["#6550b9", "#2a7e3b", "#a1305a", "#0b68b8", "#9a4a12", "#5b5a55"]

export function avatarColor(id: number | undefined): string {
  const n = Number.isInteger(id) ? Math.abs(id as number) : 0
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}

export function initial(name: string | undefined): string {
  const ch = (name ?? "").trim().charAt(0)
  return ch ? ch.toUpperCase() : "?"
}
