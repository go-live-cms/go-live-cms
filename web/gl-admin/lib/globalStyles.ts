import {
  CONTRAST_PAIRS,
  CONTRAST_TEXT,
  BLOCK_COLOR_SURFACES,
  SYSTEM_FONT_STACKS,
  contrastRatio,
  normalizeColor,
  validateGlobalStyles,
  type FontOption,
  type GlobalStylesTheme,
} from "@/lib/globalStyles"

// The global styles screen's rules (#487, docs/design/theme-builder.md 6, 9 and 13): which
// fields the active theme's declared tokens make, what the form holds (each field's typed
// text, only where it differs from the theme's default), the draft it saves, per-group
// Reset, the messages it shows and the contrast table. Validation is the shared
// validator's (src/lib/globalStyles.ts, pinned with the API by globalStyleVectors.json),
// so the form refuses what the API refuses, with the same messages.

export type FieldKind = "color" | "length" | "lineHeight" | "font"
export type StyleGroupId = "colors" | "blockColors" | "fonts" | "typeScale" | "layout" | "spacingRadius"

/** One editable token: its dotted path in the override (6.2), and how it reads. */
export interface StyleField {
  path: string
  group: StyleGroupId
  kind: FieldKind
  /** The field's name, also its accessible name: "Primary (light)", "Content width". */
  label: string
  /** The theme's value, as the field shows it. A font is the option id that matches, else "". */
  defaultText: string
}

export interface StyleGroup {
  id: StyleGroupId
  title: string
  /** The paths it covers, as prefixes of field paths (design 9: Reset removes them). */
  prefixes: readonly string[]
}

export const STYLE_GROUPS: readonly StyleGroup[] = [
  { id: "colors", title: "Colours", prefixes: ["colors."] },
  { id: "blockColors", title: "Block colours", prefixes: ["blockColors."] },
  { id: "fonts", title: "Fonts", prefixes: ["typography.fontFamily."] },
  { id: "typeScale", title: "Type scale", prefixes: ["typography.fontSize.", "typography.lineHeight."] },
  { id: "layout", title: "Layout", prefixes: ["layout."] },
  { id: "spacingRadius", title: "Spacing & radius", prefixes: ["spacing.", "radius."] },
]

export const styleGroup = (id: StyleGroupId) => STYLE_GROUPS.find((group) => group.id === id)!

/** A colour token with its light and dark fields, side by side (6.1). */
export interface ColorRow {
  name: string
  label: string
  use?: string
  light?: StyleField
  dark?: StyleField
}

export interface BlockColorToken {
  token: string
  label: string
  rows: ColorRow[]
}

/** What the screen draws for a theme: its fields, by group, in display order. */
export interface StyleForm {
  colors: ColorRow[]
  blockColors: BlockColorToken[]
  fonts: StyleField[]
  fontSizes: StyleField[]
  lineHeights: StyleField[]
  layout: StyleField[]
  spacing: StyleField[]
  radius: StyleField[]
  fields: ReadonlyMap<string, StyleField>
  fontOptions: readonly FontOption[]
}

// ---- Names ----

// The default theme's colours as its canvas names them; another theme's own names are
// humanized ("surface2" → "Surface 2", "infoBg" → "Info background").
const COLOR_NAMES: Record<string, [string, string?]> = {
  primary: ["Primary", "Links, buttons, focus"],
  primaryHover: ["Primary hover", "Links and buttons under the pointer"],
  primarySubtle: ["Primary subtle", "Selected items"],
  onPrimary: ["On primary", "Text on primary buttons"],
  secondary: ["Secondary", "Headings, site title"],
  accent: ["Accent", "Quote marks; never text"],
  background: ["Background", "The page"],
  surface: ["Surface", "Cards, code, footer"],
  surface2: ["Surface 2", "Inline code"],
  text: ["Text", "Body copy"],
  textMuted: ["Text muted", "Dates, captions, meta"],
  border: ["Border", "Dividers only"],
  borderStrong: ["Border strong", "Outline buttons, checkboxes"],
  focus: ["Focus", "Focus rings"],
  highlight: ["Highlight", "Search matches, highlighted text"],
}
const COLOR_ORDER = Object.keys(COLOR_NAMES).concat([
  "info",
  "infoBg",
  "success",
  "successBg",
  "warning",
  "warningBg",
  "danger",
  "dangerBg",
])
const FONT_NAMES: Record<string, string> = { base: "Body", heading: "Headings", mono: "Code" }
const FONT_ORDER = ["base", "heading", "mono"]
const SIZE_ORDER = ["xs", "sm", "base", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl"]
const LINE_HEIGHT_ORDER = ["tight", "snug", "normal", "relaxed", "loose"]
const LAYOUT_NAMES: Record<string, string> = {
  container: "Container",
  wideWidth: "Wide width",
  contentWidth: "Content width",
  gutter: "Gutter",
  headerHeight: "Header height",
}
const RADIUS_ORDER = ["none", "xs", "sm", "md", "lg", "xl", "2xl", "full"]

/** "surface2" → "Surface 2", "infoBg" → "Info background", "wideWidth" → "Wide width". */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .split(" ")
    .map((word) => (word === "Bg" ? "background" : word.toLowerCase()))
  const text = words.join(" ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const colorName = (name: string): [string, string?] => COLOR_NAMES[name] ?? [humanize(name)]

// Known keys first in their order, then the rest by name (numbers by value).
function ordered(keys: string[], order: readonly string[]): string[] {
  const rank = (key: string) => {
    const i = order.indexOf(key)
    return i < 0 ? order.length : i
  }
  return [...keys].sort((a, b) => rank(a) - rank(b) || Number(a) - Number(b) || 0 || (a < b ? -1 : a > b ? 1 : 0))
}

// ---- Fields from the declared tokens ----

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)
const group = (root: unknown, ...path: string[]): Record<string, unknown> => {
  const value = path.reduce<unknown>(
    (current, key) => (isObject(current) && own(current, key) ? current[key] : undefined),
    root
  )
  return isObject(value) ? value : {}
}

/** A value as a field shows it. */
export const textOf = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : ""

/** The option a font stack is, so the select shows the theme's own choice; "" when none is. */
export function fontIdForStack(stack: unknown, fontOptions: readonly FontOption[]): string {
  if (typeof stack !== "string") return ""
  const option = fontOptions.find((o) => o.stack === stack)
  if (option) return option.id
  const system = Object.entries(SYSTEM_FONT_STACKS).find(([, s]) => s === stack)
  return system ? system[0] : ""
}

/** The screen's fields for a theme's declared tokens (the API's `tokens`). Only declared tokens can be edited (6.1). */
export function buildStyleForm(tokens: Record<string, unknown>, fontOptions: readonly FontOption[] = []): StyleForm {
  const fields = new Map<string, StyleField>()
  const add = (field: StyleField) => {
    fields.set(field.path, field)
    return field
  }

  const light = group(tokens, "colors", "light")
  const dark = group(tokens, "colors", "dark")
  const colorKeys = ordered([...new Set([...Object.keys(light), ...Object.keys(dark)])], COLOR_ORDER)
  const colors: ColorRow[] = colorKeys.map((name) => {
    const [label, use] = colorName(name)
    const row: ColorRow = { name, label, use }
    for (const palette of ["light", "dark"] as const) {
      const declared = palette === "light" ? light : dark
      if (!own(declared, name) || typeof declared[name] !== "string") continue
      row[palette] = add({
        path: `colors.${palette}.${name}`,
        group: "colors",
        kind: "color",
        label: `${label} (${palette})`,
        defaultText: textOf(declared[name]),
      })
    }
    return row
  })

  const blockLight = group(tokens, "blockColors", "light")
  const blockDark = group(tokens, "blockColors", "dark")
  const blockKeys = ordered([...new Set([...Object.keys(blockLight), ...Object.keys(blockDark)])], [])
  const blockColors: BlockColorToken[] = blockKeys.map((token) => {
    const tokenLabel = humanize(token)
    const rows = (["text", "background"] as const).map((part) => {
      const label = `${tokenLabel} ${part === "text" ? "text" : "fill"}`
      const row: ColorRow = { name: `${token}.${part}`, label }
      for (const palette of ["light", "dark"] as const) {
        const declared = group(palette === "light" ? blockLight : blockDark, token)
        if (typeof declared[part] !== "string") continue
        row[palette] = add({
          path: `blockColors.${palette}.${token}.${part}`,
          group: "blockColors",
          kind: "color",
          label: `${label} (${palette})`,
          defaultText: textOf(declared[part]),
        })
      }
      return row
    })
    return { token, label: tokenLabel, rows }
  })

  const fontFamily = group(tokens, "typography", "fontFamily")
  const fonts = ordered(Object.keys(fontFamily), FONT_ORDER).map((key) =>
    add({
      path: `typography.fontFamily.${key}`,
      group: "fonts",
      kind: "font",
      label: FONT_NAMES[key] ?? humanize(key),
      defaultText: fontIdForStack(fontFamily[key], fontOptions),
    })
  )
  const fontSize = group(tokens, "typography", "fontSize")
  const fontSizes = ordered(Object.keys(fontSize), SIZE_ORDER).map((key) =>
    add({
      path: `typography.fontSize.${key}`,
      group: "typeScale",
      kind: "length",
      label: `Size ${key}`,
      defaultText: textOf(fontSize[key]),
    })
  )
  const lineHeight = group(tokens, "typography", "lineHeight")
  const lineHeights = ordered(Object.keys(lineHeight), LINE_HEIGHT_ORDER).map((key) =>
    add({
      path: `typography.lineHeight.${key}`,
      group: "typeScale",
      kind: "lineHeight",
      label: `${humanize(key)} line height`,
      defaultText: textOf(lineHeight[key]),
    })
  )
  const layoutTokens = group(tokens, "layout")
  const layout = ordered(Object.keys(layoutTokens), Object.keys(LAYOUT_NAMES)).map((key) =>
    add({
      path: `layout.${key}`,
      group: "layout",
      kind: "length",
      label: LAYOUT_NAMES[key] ?? humanize(key),
      defaultText: textOf(layoutTokens[key]),
    })
  )
  const spacingTokens = group(tokens, "spacing")
  const spacing = ordered(Object.keys(spacingTokens), []).map((key) =>
    add({
      path: `spacing.${key}`,
      group: "spacingRadius",
      kind: "length",
      label: `space-${key}`,
      defaultText: textOf(spacingTokens[key]),
    })
  )
  const radiusTokens = group(tokens, "radius")
  const radius = ordered(Object.keys(radiusTokens), RADIUS_ORDER).map((key) =>
    add({
      path: `radius.${key}`,
      group: "spacingRadius",
      kind: "length",
      label: `radius-${key}`,
      defaultText: textOf(radiusTokens[key]),
    })
  )

  return { colors, blockColors, fonts, fontSizes, lineHeights, layout, spacing, radius, fields, fontOptions }
}

// ---- What the form holds ----

/** Each overridden field's typed text, by path. A field without an entry shows the theme's value. */
export type Overrides = Readonly<Record<string, string>>

function leaves(value: unknown, path: string, out: [string, unknown][]) {
  if (isObject(value)) {
    for (const key of Object.keys(value)) leaves(value[key], path ? `${path}.${key}` : key, out)
  } else out.push([path, value])
  return out
}

/**
 * The form's state for a stored draft. `stale` are the draft's paths this theme no longer
 * declares (5.5): kept by the API, refused on a save, so the next save leaves them out.
 */
export function overridesFromDraft(form: StyleForm, draft: unknown): { overrides: Overrides; stale: string[] } {
  const overrides: Record<string, string> = {}
  const stale: string[] = []
  for (const [path, value] of leaves(draft, "", [])) {
    if (!path) continue
    if (form.fields.has(path)) overrides[path] = textOf(value)
    else stale.push(path)
  }
  return { overrides, stale }
}

/** What a field shows. */
export const fieldText = (field: StyleField, overrides: Overrides) =>
  own(overrides, field.path) ? overrides[field.path] : field.defaultText

// The same value as the theme's: a colour in any case, a line height as a number, the rest
// exactly as typed (the API takes text as it is, so " 8px" is not "8px").
function sameAsDefault(field: StyleField, text: string): boolean {
  if (field.kind === "color") {
    const color = normalizeColor(text)
    return color !== null && color === normalizeColor(field.defaultText)
  }
  if (field.kind === "lineHeight") return LINE_HEIGHT_TEXT.test(text) && Number(text) === Number(field.defaultText)
  return text === field.defaultText
}

const LINE_HEIGHT_TEXT = /^(\d+(\.\d+)?|\.\d+)$/

/** Sets a field's text. Typing the theme's value back removes the override, so the draft holds only real changes. */
export function setOverride(form: StyleForm, overrides: Overrides, path: string, text: string): Overrides {
  const field = form.fields.get(path)
  if (!field) return overrides
  const next = { ...overrides }
  if (sameAsDefault(field, text)) delete next[path]
  else next[path] = text
  return next
}

const inGroup = (path: string, group: StyleGroup) => group.prefixes.some((prefix) => path.startsWith(prefix))

/** Reset (design 9): the group's keys leave the draft, so the theme's values apply again on publish. */
export function resetGroup(overrides: Overrides, id: StyleGroupId): Overrides {
  const group = styleGroup(id)
  return Object.fromEntries(Object.entries(overrides).filter(([path]) => !inGroup(path, group)))
}

export const groupChanged = (overrides: Overrides, id: StyleGroupId) =>
  Object.keys(overrides).some((path) => inGroup(path, styleGroup(id)))

/**
 * A field's text as the API takes it: a line height that reads as a plain decimal is a
 * number; everything else is sent as typed, never trimmed or fixed, so the form refuses
 * exactly what the API would.
 */
export function parseField(field: StyleField, text: string): unknown {
  if (field.kind === "lineHeight" && LINE_HEIGHT_TEXT.test(text)) return Number(text)
  return text
}

/** The draft PUT /site-design/global-styles takes: every override, nested as ThemeConfig (6.2). */
export function draftFromOverrides(form: StyleForm, overrides: Overrides): Record<string, unknown> {
  const draft: Record<string, unknown> = {}
  for (const path of Object.keys(overrides).sort()) {
    const field = form.fields.get(path)
    if (!field) continue
    const keys = path.split(".")
    let node = draft
    for (const key of keys.slice(0, -1)) {
      if (!isObject(node[key])) node[key] = {}
      node = node[key] as Record<string, unknown>
    }
    node[keys[keys.length - 1]] = parseField(field, overrides[path])
  }
  return draft
}

// ---- Messages: the validator's, which are the API's ----

/** The validator's message for a path ("colors.light.primary: must be …"), as a sentence under its field. */
export function fieldMessage(message: string, path: string): string {
  const text = path && message.startsWith(`${path}: `) ? message.slice(path.length + 2) : message
  const sentence = /^must /.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

/**
 * The problem with each field, by path: each overridden field on its own (so every wrong
 * value is named at once), then, when they all pass, the whole draft (the order rules:
 * content width ≤ wide width ≤ container, spacing steps). Empty when the draft would save.
 */
export function fieldErrors(form: StyleForm, overrides: Overrides, theme: GlobalStylesTheme): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const path of Object.keys(overrides)) {
    const field = form.fields.get(path)
    if (!field) continue
    const single = draftFromOverrides(form, { [path]: overrides[path] })
    const result = validateGlobalStyles(single, theme)
    if (!result.ok && result.code !== "token_order") errors[path] = fieldMessage(result.message, result.path)
  }
  if (Object.keys(errors).length > 0) return errors
  const result = validateGlobalStyles(draftFromOverrides(form, overrides), theme)
  if (!result.ok) errors[result.path] = fieldMessage(result.message, result.path)
  return errors
}

/** The 409 notice's account of the change that wasn't saved: "Primary (light) to #155e4b", "Reset colours". */
export type LastChange = { kind: "field"; path: string; text: string } | { kind: "reset"; group: StyleGroupId | "all" }

export function describeChange(form: StyleForm, change: LastChange): string {
  if (change.kind === "reset")
    return change.group === "all" ? "Reset all" : `Reset ${styleGroup(change.group).title.toLowerCase()}`
  const field = form.fields.get(change.path)
  const label = field?.label ?? change.path
  if (field?.kind === "font") {
    const option = form.fontOptions.find((o) => o.id === change.text)
    return `${label} to ${option?.label ?? fontLabel(change.text) ?? "the theme's font"}`
  }
  return `${label} to ${change.text || "nothing"}`
}

// ---- Fonts ----

const SYSTEM_FONT_LABELS: Record<string, string> = {
  "system-sans": "System sans",
  "system-serif": "System serif",
  "system-mono": "System mono",
}

function fontLabel(id: string): string | null {
  return SYSTEM_FONT_LABELS[id] ?? null
}

export interface FontChoice {
  value: string
  label: string
  description?: string
}

/** A font select's choices: the theme's fonts, then the reader's system fonts (6.1). */
export function fontChoices(
  form: StyleForm,
  field: StyleField,
  themeName: string,
  systemFonts: readonly string[]
): FontChoice[] {
  const choices: FontChoice[] = []
  // A theme whose default isn't one of its options keeps it as a choice of its own.
  if (field.defaultText === "") choices.push({ value: "", label: `${themeName}'s default` })
  for (const option of form.fontOptions)
    choices.push({ value: option.id, label: option.label, description: `${themeName}'s font` })
  for (const id of systemFonts)
    choices.push({
      value: id,
      label: fontLabel(id) ?? humanize(id),
      description: "On the reader's device, no download",
    })
  return choices
}

/** The CSS stack a font id stands for (theme option or system), for the screen's own samples. */
export function fontStack(form: StyleForm, id: string): string | undefined {
  return form.fontOptions.find((o) => o.id === id)?.stack ?? SYSTEM_FONT_STACKS[id]
}

// ---- Contrast (6.3): shown beside the colours, a warning, never a refusal ----

export type Palette = "light" | "dark"

export interface PairResult {
  ratio: number
  minimum: number
  pass: boolean
}

export interface ContrastRow {
  id: string
  label: string
  light?: PairResult
  dark?: PairResult
}

export interface ContrastSummary {
  /** The main pairs, always shown, then every other pair that fails. */
  rows: ContrastRow[]
  /** The rest of the theme's pairs, counted per palette. */
  others: Record<Palette, { total: number; passing: number }>
  /** Block colours as text on the page's surfaces and as fills under the page's text. */
  blocks: Record<Palette, { total: number; passing: number }>
  /** Colours in a failing pair, as "light:primary" or "dark:blockColors.red.text": their fields get the flag. */
  flagged: ReadonlySet<string>
  failing: number
}

const FEATURED: readonly (readonly [string, string])[] = [
  ["text", "background"],
  ["textMuted", "surface"],
  ["primary", "background"],
  ["primary", "surface"],
  ["onPrimary", "primary"],
]

function palettes(theme: GlobalStylesTheme, styles: unknown): Record<Palette, Record<string, string>> {
  const merged = (declared: Record<string, unknown>, override: Record<string, unknown>) => {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(declared)) {
      const color = normalizeColor(value)
      if (color) out[key] = color
    }
    for (const [key, value] of Object.entries(override)) {
      const color = normalizeColor(value)
      if (color && own(out, key)) out[key] = color
    }
    return out
  }
  const result = { light: {}, dark: {} } as Record<Palette, Record<string, string>>
  for (const palette of ["light", "dark"] as const) {
    result[palette] = merged(group(theme.tokens, "colors", palette), group(styles, "colors", palette))
    for (const token of Object.keys(group(theme.tokens, "blockColors", palette))) {
      const block = merged(
        group(theme.tokens, "blockColors", palette, token),
        group(styles, "blockColors", palette, token)
      )
      for (const [part, color] of Object.entries(block)) result[palette][`blockColors.${token}.${part}`] = color
    }
  }
  return result
}

function colorLabel(name: string): string {
  const block = /^blockColors\.([^.]+)\.(text|background)$/.exec(name)
  if (block) return `${humanize(block[1])} ${block[2] === "text" ? "text" : "fill"}`
  return colorName(name)[0]
}

/** "Primary on surface", "Red text on surface". */
export function pairLabel(foreground: string, background: string): string {
  const bg = colorLabel(background)
  return `${colorLabel(foreground)} on ${bg.charAt(0).toLowerCase()}${bg.slice(1)}`
}

/** A failing pair as the publish dialog lists it: "Primary on surface · dark". */
export const failureLabel = (f: { palette: string; foreground: string; background: string }) =>
  `${pairLabel(f.foreground, f.background)} · ${f.palette}`

/** "16.0:1", rounded down: a failing ratio never reads as its minimum (4.49 is "4.4:1", not "4.5:1"). */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`
}

/** "needs 4.5:1", "needs 3:1". */
export const formatMinimum = (minimum: number) => `needs ${minimum}:1`

/** The contrast table for the form's colours (the theme's, with every valid override). */
export function contrastSummary(theme: GlobalStylesTheme, styles: unknown): ContrastSummary {
  const colors = palettes(theme, styles)
  const flagged = new Set<string>()
  const counts = () => ({ light: { total: 0, passing: 0 }, dark: { total: 0, passing: 0 } })
  const others = counts()
  const blocks = counts()
  // Every pair's results, both palettes; the table shows the featured ones and the failing ones.
  const all = new Map<string, ContrastRow>()
  const shown = new Set<string>()
  const row = (fg: string, bg: string) => {
    const id = `${fg}/${bg}`
    if (!all.has(id)) all.set(id, { id, label: pairLabel(fg, bg) })
    return all.get(id)!
  }
  const isFeatured = (fg: string, bg: string) => FEATURED.some(([f, b]) => f === fg && b === bg)
  for (const [fg, bg] of FEATURED) {
    if (CONTRAST_PAIRS.some(([f, b]) => f === fg && b === bg)) shown.add(row(fg, bg).id)
  }
  let failing = 0

  const check = (
    palette: Palette,
    fg: string,
    bg: string,
    minimum: number,
    tally: ContrastSummary["others"] | null
  ) => {
    const pair = colors[palette]
    if (!own(pair, fg) || !own(pair, bg)) return
    const ratio = contrastRatio(pair[fg], pair[bg])
    const result: PairResult = { ratio, minimum, pass: ratio >= minimum }
    if (tally) {
      tally[palette].total++
      if (result.pass) tally[palette].passing++
    }
    if (!result.pass) {
      failing++
      flagged.add(`${palette}:${fg}`)
      flagged.add(`${palette}:${bg}`)
    }
    row(fg, bg)[palette] = result
    if (!result.pass) shown.add(`${fg}/${bg}`)
  }

  for (const palette of ["light", "dark"] as const) {
    for (const [fg, bg, minimum] of CONTRAST_PAIRS) check(palette, fg, bg, minimum, isFeatured(fg, bg) ? null : others)
    for (const token of Object.keys(group(theme.tokens, "blockColors", palette)).sort()) {
      for (const surface of BLOCK_COLOR_SURFACES)
        check(palette, `blockColors.${token}.text`, surface, CONTRAST_TEXT, blocks)
      check(palette, "text", `blockColors.${token}.background`, CONTRAST_TEXT, blocks)
    }
  }
  return { rows: [...shown].map((id) => all.get(id)!), others, blocks, flagged, failing }
}

/** "All 28 pass", "26 of 28 pass", "None" for a palette without such pairs. */
export function passCount({ total, passing }: { total: number; passing: number }): string {
  if (total === 0) return "None"
  return passing === total ? `All ${total} pass` : `${passing} of ${total} pass`
}

/** The styles-only publish's account of what goes live: "Colours, Fonts". */
export function changedGroupsLabel(groups: readonly string[]): string {
  const titles: Record<string, string> = {
    colors: "Colours",
    blockColors: "Block colours",
    fonts: "Fonts",
    typeScale: "Type scale",
    layout: "Layout",
    spacing: "Spacing",
    radius: "Radius",
  }
  return groups.map((name) => titles[name] ?? humanize(name)).join(", ")
}
