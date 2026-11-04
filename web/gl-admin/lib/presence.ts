// A user's presence colour: the same one collaborators' carets use
// (postCollab.ts), id % 8 over the --presence-N tokens. Shared by the React
// Avatar and the account pages (no React), so it lives outside both.
export function presenceColor(id: number): string {
  return `var(--presence-${(Math.abs(Math.trunc(id)) % 8) + 1})`
}

// An avatar URL that is safe to render: a same-origin /uploads path to one of the
// API's avatar files (#334, api/avatar_utils.go), never anything else. Presence
// avatars come from other clients' awareness, which any collaborator can set, so
// an arbitrary URL there would let them make every viewer fetch a tracking image.
// Anything else (null, absolute URLs, `//host`, `..`) gives null: the initial.
const AVATAR_SRC = /^\/uploads\/(?:[A-Za-z0-9_-]+\/)*_avatars\/avatar-[0-9a-f]{32}\.(?:jpg|png)$/

export function safeAvatarSrc(src: unknown): string | null {
  return typeof src === "string" && AVATAR_SRC.test(src) ? src : null
}