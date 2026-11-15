/**
 * Author initials for bylines (#345). The colours carry white text, so each one keeps
 * 4.5:1 against #ffffff (tokens.test.ts).
 */
// The colours and initials are core's (src/lib/bylines.ts), shared with the post_byline site
// block (#489), so a block template and this theme credit people alike.
export { AVATAR_COLORS, avatarColor, initial } from "@/lib/bylines"

// The uploaded picture to show instead of the initial (#334), or null. Only an API
// avatar path (/uploads/…/_avatars/avatar-<hex>.jpg|png) passes, so a bad stored
// value can't point the page at another host.
export { safeAvatarSrc as avatarSrc } from "@gl-admin/lib/presence"