/**
 * A theme's registered styles and scripts (`assets` in theme.config.ts), the part of the
 * theme contract (#484, docs/design/theme-builder.md 3.5) that lets a layout the theme
 * didn't write (#491's generic block template layout) include everything the theme's own
 * base layout includes. The middleware puts the active theme's `assets` in
 * `Astro.locals.themeAssets`; `ThemeScripts.astro` renders the scripts.
 */

export interface ThemeStyleAsset {
  src: string
  media?: string
}

export interface ThemeScriptAsset {
  src: string
  defer?: boolean
  async?: boolean
  type?: string
  /**
   * Render-blocking: a plain `<script src>` in `<head>`, run before the first paint, for a
   * script such as the default theme's `theme-init.js` that sets `data-theme` so a dark page
   * never flashes light. Never inline (a CSP of `script-src 'self'` must keep working), and
   * `defer`/`async` don't apply. Other scripts go before `</body>`, and so does a
   * `type: "module"` script marked blocking (browsers always defer modules).
   */
  blocking?: boolean
  /**
   * `data-*` attributes for the element, without the prefix: `{ "storage-key": "x" }` is
   * `data-storage-key="x"`. Names are lowercase letters, digits and `-`; others are left out.
   */
  data?: Record<string, string>
}

/**
 * #498: a font file the page should start loading at once (`<link rel="preload" as="font"
 * crossorigin>`), as a theme's base layout hard-codes for the fonts its first screen uses, so a
 * generic layout preloads the same ones. A path on this site (`/themes/<slug>/…`), `type` its MIME
 * type (`font/woff2`).
 */
export interface ThemeFontAsset {
  href: string
  type?: string
}

export interface ThemeAssets {
  styles?: ThemeStyleAsset[]
  scripts?: ThemeScriptAsset[]
  /** #498: fonts to preload. */
  fonts?: ThemeFontAsset[]
}

const DATA_NAME = /^[a-z][a-z0-9-]*$/

/** The fonts to preload (#498): only paths on this site, so a theme's config can't make the page fetch another origin's. */
export function preloadFonts(fonts: ThemeFontAsset[] | undefined): ThemeFontAsset[] {
  return (fonts ?? []).filter((font) => typeof font?.href === "string" && /^\/(?!\/)/.test(font.href))
}

/** The `data-*` attributes of a script, ready to spread onto the element. */
export function scriptDataAttributes(script: ThemeScriptAsset): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const [name, value] of Object.entries(script.data ?? {})) {
    if (DATA_NAME.test(name) && typeof value === "string") attributes[`data-${name}`] = value
  }
  return attributes
}

// A module script is always deferred by the browser, so it can't block: one registered as
// blocking goes with the other scripts instead.
const isBlocking = (script: ThemeScriptAsset) => script.blocking === true && script.type?.trim().toLowerCase() !== "module"

/** The scripts for `<head>`, run before the first paint, in registration order. */
export function blockingScripts(scripts: ThemeScriptAsset[] | undefined): ThemeScriptAsset[] {
  return (scripts ?? []).filter((script) => script?.src && isBlocking(script))
}

/** The scripts for the end of `<body>`, in registration order. */
export function bodyScripts(scripts: ThemeScriptAsset[] | undefined): ThemeScriptAsset[] {
  return (scripts ?? []).filter((script) => script?.src && !isBlocking(script))
}
