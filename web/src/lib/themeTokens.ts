/**
 * Theme tokens → CSS custom properties, in core (#484, docs/design/theme-builder.md 3.5).
 *
 * A theme declares its tokens in theme.config.ts (colours for light and dark, block colours,
 * typography, layout widths, spacing, radius) and its base layout emits them with
 *
 *   themeCssVariables(resolveThemeTokens(themeConfig, Astro.locals.globalStyles))
 *
 * so the config is the single source of the values and the theme's CSS only reads var(--…).
 * `resolveThemeTokens` merges the site's published global styles (#485, globalStyles.ts)
 * into the config. A theme that never calls it still renders, it just ignores global styles
 * (and says so with `supports.globalStyles`).
 *
 * Light is the default. Dark applies under [data-theme="dark"] (set by the theme's script
 * from the reader's choice), and under prefers-color-scheme: dark unless the page says
 * data-theme="light", so a reader without JavaScript still gets their system's theme.
 *
 * Moved here from themes/default/tokens.ts; the output is unchanged.
 */
import { SYSTEM_FONT_STACKS, isLineHeight, normalizeColor, normalizeLength, type FontOption } from "./globalStyles"

export type { FontOption } from "./globalStyles"

/** Block colours (#356): per palette token, a text colour and a block fill. */
export type BlockColorPalette = Record<string, { text: string; background: string }>

/**
 * What core reads from a theme's config to emit its tokens. Structural, so any theme's
 * ThemeConfig fits. A palette is the theme's own names (`primary`, `textMuted`, …) →
 * `#rrggbb`; an `object` because themes declare them as interfaces.
 */
export interface ThemeTokenConfig {
  colors: { light: object; dark: object }
  blockColors?: { light: BlockColorPalette; dark: BlockColorPalette }
  typography: {
    fontFamily: { base: string; heading: string; mono: string }
    fontSize: Record<string, string>
    lineHeight?: Record<string, number>
  }
  layout: { container: string; gutter: string; contentWidth?: string; wideWidth?: string; headerHeight?: string }
  spacing?: Record<string, string>
  radius?: Record<string, string>
  // The fonts an override may pick for fontFamily.* (design 6.1), by id; core's system
  // stacks (SYSTEM_FONT_STACKS) are always offered too.
  fontOptions?: readonly FontOption[]
}

/**
 * The site's published override of a theme's tokens (design 6.2): the same nesting as the
 * config, partial. It can only change tokens the theme declares, never add one. Font
 * families are option ids: one of the theme's fontOptions or a system stack.
 */
export interface GlobalStyles {
  colors?: { light?: Record<string, string>; dark?: Record<string, string> }
  blockColors?: { light?: Record<string, { text?: string; background?: string }>; dark?: Record<string, { text?: string; background?: string }> }
  typography?: {
    fontFamily?: Record<string, string>
    fontSize?: Record<string, string>
    lineHeight?: Record<string, number>
  }
  layout?: Record<string, string>
  spacing?: Record<string, string>
  radius?: Record<string, string>
}

/** No override: what `Astro.locals.globalStyles` holds until an admin publishes some. */
export const NO_GLOBAL_STYLES: Readonly<GlobalStyles> = Object.freeze({})

/**
 * The override GET /themes/active serves (`global_styles`, published only) as the
 * middleware's `locals.globalStyles`: anything but an object is no override.
 */
export function publishedGlobalStyles(value: unknown): Readonly<GlobalStyles> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0 ? (value as GlobalStyles) : NO_GLOBAL_STYLES
}

/**
 * Whether the theme merges global styles into its tokens: `supports.globalStyles: true` in
 * its config, set by a theme whose base layout calls resolveThemeTokens. The Site editor
 * says a theme without it doesn't support them.
 */
export function supportsGlobalStyles(config: object): boolean {
  return (config as { supports?: { globalStyles?: unknown } }).supports?.globalStyles === true
}

// primaryHover -> --color-primary-hover, surface2 -> --color-surface-2
export function cssName(key: string): string {
  return key.replace(/([a-z])([A-Z0-9])/g, "$1-$2").toLowerCase()
}

function declarations(entries: [string, string | number][]): string {
  return entries.map(([name, value]) => `--${name}:${value};`).join("")
}

function colorDeclarations(colors: object): string {
  return declarations(
    Object.entries(colors)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [`color-${cssName(key)}`, value as string]),
  )
}

// Block colours (#356): `--block-red`, `--block-red-background`.
function blockColorDeclarations(palette: BlockColorPalette | undefined): string {
  return declarations(
    Object.entries(palette ?? {}).flatMap(([token, { text, background }]): [string, string][] => [
      [`block-${token}`, text],
      [`block-${token}-background`, background],
    ]),
  )
}

// The non-colour tokens: fonts, sizes, line heights, widths, spacing, radius.
export function staticTokens(config: ThemeTokenConfig): [string, string | number][] {
  const { typography, layout } = config
  const entries: [string, string | number][] = [
    ["font-base", typography.fontFamily.base],
    ["font-heading", typography.fontFamily.heading],
    ["font-mono", typography.fontFamily.mono],
    ...Object.entries(typography.fontSize).map(([k, v]): [string, string] => [`size-${k}`, v]),
    ...Object.entries(typography.lineHeight ?? {}).map(([k, v]): [string, number] => [`leading-${k}`, v]),
    ["container-width", layout.container],
    ["container-gutter", layout.gutter],
  ]
  if (layout.contentWidth) entries.push(["content-width", layout.contentWidth])
  if (layout.wideWidth) entries.push(["wide-width", layout.wideWidth])
  if (layout.headerHeight) entries.push(["header-height", layout.headerHeight])
  for (const [k, v] of Object.entries(config.spacing ?? {})) entries.push([`space-${k}`, v])
  for (const [k, v] of Object.entries(config.radius ?? {})) entries.push([`radius-${k}`, v])
  return entries
}

/** The `<style>` text for the theme's tokens: three rules, one per line. */
export function themeCssVariables(config: ThemeTokenConfig): string {
  const light = colorDeclarations(config.colors.light) + blockColorDeclarations(config.blockColors?.light)
  const dark = colorDeclarations(config.colors.dark) + blockColorDeclarations(config.blockColors?.dark)
  return [
    `:root{color-scheme:light;${light}${declarations(staticTokens(config))}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;${dark}}}`,
    `:root[data-theme="dark"]{color-scheme:dark;${dark}}`,
  ].join("\n")
}

// The values go into a <style> element. The API validates every value against the grammar
// of design 6.3 before it is stored (api/global_styles.go); this is the last line, whatever
// the stored row holds: each token accepts exactly what its kind can be, by the same
// grammar (globalStyles.ts): a colour `#1b7760`, a length `680px` or
// `clamp(1rem, 1rem + 1vw, 2rem)`, a line height from 1 to 2.5. Nothing else, so nothing
// can close a declaration or the element, or name url(), var(), calc() or expression().
type Accept = (value: unknown) => string | number | null
const acceptColor: Accept = normalizeColor
const acceptLength: Accept = normalizeLength
const acceptLineHeight: Accept = (value) => (isLineHeight(value) ? value : null)

function isEmpty(styles: GlobalStyles | null | undefined): boolean {
  return !styles || typeof styles !== "object" || Object.keys(styles).length === 0
}

/** `base` with `override`'s values for the keys `base` declares; other keys are ignored. */
function mergeDeclared<T extends object>(base: T, override: unknown, accept: Accept): T {
  if (!override || typeof override !== "object") return base
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(override)) {
    if (!Object.prototype.hasOwnProperty.call(base, key) || (base as Record<string, unknown>)[key] === undefined) continue
    const accepted = accept(value)
    if (accepted !== null) merged[key] = accepted
  }
  return merged as T
}

function mergePalette(base: BlockColorPalette, override: unknown): BlockColorPalette {
  if (!override || typeof override !== "object") return base
  const merged: BlockColorPalette = { ...base }
  for (const [token, value] of Object.entries(override)) {
    if (!Object.prototype.hasOwnProperty.call(base, token)) continue
    merged[token] = mergeDeclared(base[token], value, acceptColor)
  }
  return merged
}

/** The CSS stack for a font id: the theme's option of that id, else a system stack. */
function fontStack(config: ThemeTokenConfig, id: unknown): string | null {
  if (typeof id !== "string") return null
  const option = config.fontOptions?.find((candidate) => candidate.id === id)
  if (option) return option.stack
  return Object.prototype.hasOwnProperty.call(SYSTEM_FONT_STACKS, id) ? SYSTEM_FONT_STACKS[id] : null
}

/**
 * The theme's tokens with the site's published global styles merged in (design 6.4).
 * With no override this is `config` itself, so a site that never customized its styles
 * emits exactly what the theme declares. Only tokens the theme declares change, and only
 * to a value of their kind; a font family id becomes its option's stack (an unknown id
 * keeps the theme's font).
 */
export function resolveThemeTokens<C extends ThemeTokenConfig>(config: C, globalStyles?: GlobalStyles | null): C {
  if (isEmpty(globalStyles)) return config
  const styles = globalStyles as GlobalStyles
  const resolved: ThemeTokenConfig = {
    ...config,
    colors: {
      light: mergeDeclared(config.colors.light, styles.colors?.light, acceptColor),
      dark: mergeDeclared(config.colors.dark, styles.colors?.dark, acceptColor),
    },
    typography: {
      ...config.typography,
      fontFamily: mergeDeclared(config.typography.fontFamily, styles.typography?.fontFamily, (id) => fontStack(config, id)),
      fontSize: mergeDeclared(config.typography.fontSize, styles.typography?.fontSize, acceptLength),
      ...(config.typography.lineHeight && { lineHeight: mergeDeclared(config.typography.lineHeight, styles.typography?.lineHeight, acceptLineHeight) }),
    },
    layout: mergeDeclared(config.layout, styles.layout, acceptLength),
  }
  if (config.blockColors) {
    resolved.blockColors = {
      light: mergePalette(config.blockColors.light, styles.blockColors?.light),
      dark: mergePalette(config.blockColors.dark, styles.blockColors?.dark),
    }
  }
  if (config.spacing) resolved.spacing = mergeDeclared(config.spacing, styles.spacing, acceptLength)
  if (config.radius) resolved.radius = mergeDeclared(config.radius, styles.radius, acceptLength)
  return resolved as C
}
