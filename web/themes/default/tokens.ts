/**
 * Turns theme.config.ts tokens into CSS custom properties (#345), so the config is the
 * single source of the values and styles/theme.css only reads var(--...).
 *
 * Light is the default. Dark applies under [data-theme="dark"] (set by
 * scripts/theme-init.js from the reader's choice), and under prefers-color-scheme: dark
 * unless the page says data-theme="light", so a reader without JavaScript still gets
 * their system's theme.
 */
import type { ThemeColors, ThemeConfig } from "./theme.config"

// primaryHover -> --color-primary-hover, surface2 -> --color-surface-2
export function cssName(key: string): string {
  return key.replace(/([a-z])([A-Z0-9])/g, "$1-$2").toLowerCase()
}

function declarations(entries: [string, string | number][]): string {
  return entries.map(([name, value]) => `--${name}:${value};`).join("")
}

function colorDeclarations(colors: ThemeColors): string {
  return declarations(
    Object.entries(colors)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [`color-${cssName(key)}`, value as string]),
  )
}

// The non-colour tokens: fonts, sizes, line heights, widths, spacing, radius.
export function staticTokens(config: ThemeConfig): [string, string | number][] {
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

export function themeCssVariables(config: ThemeConfig): string {
  const light = colorDeclarations(config.colors.light)
  const dark = colorDeclarations(config.colors.dark)
  return [
    `:root{color-scheme:light;${light}${declarations(staticTokens(config))}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;${dark}}}`,
    `:root[data-theme="dark"]{color-scheme:dark;${dark}}`,
  ].join("\n")
}
