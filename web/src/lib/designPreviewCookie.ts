/**
 * The design preview cookie's names (#486, docs/design/theme-builder.md 8.3), in a module
 * of their own so httpCache.ts and designPreview.ts both read them without importing each
 * other.
 *
 * Like the API's refresh cookie (#159): whenever the cookie is Secure it is
 * `__Host-gl_design_preview` (Secure, Path=/, no Domain, so a sibling subdomain or a
 * plain-HTTP response can't plant or shadow it). Only `astro dev` over plain HTTP uses the
 * unprefixed name, which can't be Secure.
 */
export const DESIGN_PREVIEW_COOKIE = "gl_design_preview"
export const HOST_DESIGN_PREVIEW_COOKIE = `__Host-${DESIGN_PREVIEW_COOKIE}`
export const DESIGN_PREVIEW_COOKIES: readonly string[] = [HOST_DESIGN_PREVIEW_COOKIE, DESIGN_PREVIEW_COOKIE]
