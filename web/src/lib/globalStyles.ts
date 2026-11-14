/**
 * Global styles (#485, docs/design/theme-builder.md section 6): a site's partial override of
 * the active theme's declared tokens, in ThemeConfig's nesting (6.2):
 *
 *   { colors: { light: { primary: "#155e4b" } }, typography: { fontFamily: { heading: "inter" } } }
 *
 * The values reach a <style> element (themeTokens.ts), so nothing free-form may: every value
 * matches the grammar of 6.3 and only keys the theme declares are accepted. The API applies
 * the same rules (api/global_styles.go) on every write and on publish; this copy is the
 * form's (#487) and the emitter's. `globalStyleVectors.json` pins both
 * (globalStyles.test.ts here, TestGlobalStyleVectors in Go): same results, same messages.
 *
 * Contrast is computed on the pairs the default theme's tokens.test.ts checks
 * (CONTRAST_PAIRS), in both palettes. A failing pair is a warning, never a refusal: publish
 * asks for confirmation (409 contrast_unconfirmed) and goes ahead with confirm_contrast.
 */

/** A theme's font choice (`fontOptions` in theme.config.ts, 6.1): stored by id, emitted as `stack`. */
export interface FontOption {
  id: string
  label: string
  stack: string
}

/** Core's system stacks (6.1), which every theme offers besides its own fontOptions. */
export const SYSTEM_FONT_STACKS: Readonly<Record<string, string>> = Object.freeze({
  "system-sans": 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  "system-serif": 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  "system-mono": "ui-monospace, Menlo, Consolas, monospace",
})

/** Tokens a theme declares, with their default values: ThemeConfig's token groups. */
export type DeclaredTokens = Record<string, unknown>

/** What validation needs of a theme: its declared tokens and its font options. */
export interface GlobalStylesTheme {
  tokens: DeclaredTokens
  fontOptions?: readonly FontOption[]
}

export type GlobalStyleErrorCode = "unknown_token" | "invalid_value" | "token_order"

export type GlobalStylesResult =
  | { ok: true; styles: Record<string, unknown> }
  | { ok: false; code: GlobalStyleErrorCode; path: string; message: string }

// ---- Grammar (6.3) ----

const LENGTH = String.raw`(?:\d{1,5}(?:\.\d{1,4})?|\.\d{1,4})(?:px|rem|em|%|vw)`
const COLOR_RE = /^#[0-9a-fA-F]{6}$/
const SIMPLE_LENGTH_RE = /^(\d{1,5}(?:\.\d{1,4})?|\.\d{1,4})(px|rem|em|%|vw)$/
// Spaces only (never tabs or newlines) inside clamp().
const CLAMP_RE = new RegExp(String.raw`^clamp\( *(${LENGTH}) *, *(${LENGTH})(?: *\+ *(${LENGTH}))? *, *(${LENGTH}) *\)$`)
const MAX_STYLE_VALUE = 100
const MIN_LINE_HEIGHT = 1
const MAX_LINE_HEIGHT = 2.5

/** `#rrggbb`, lowercased; null when it isn't one. */
export function normalizeColor(value: unknown): string | null {
  return typeof value === "string" && COLOR_RE.test(value) ? value.toLowerCase() : null
}

/**
 * A length (`680px`, `1.5rem`; px, rem, em, % or vw) or `clamp(<length>, <length or sum>,
 * <length>)`, written with single spaces; null when it isn't one. No other function: no
 * calc(), var(), url().
 */
export function normalizeLength(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_STYLE_VALUE) return null
  if (SIMPLE_LENGTH_RE.test(value)) return value
  const m = CLAMP_RE.exec(value)
  if (!m) return null
  const middle = m[3] ? `${m[2]} + ${m[3]}` : m[2]
  return `clamp(${m[1]}, ${middle}, ${m[4]})`
}

/** A line height: a plain number from 1 to 2.5. */
export function isLineHeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_LINE_HEIGHT && value <= MAX_LINE_HEIGHT
}

function simpleLength(value: string): [number, string] | null {
  const m = SIMPLE_LENGTH_RE.exec(value)
  return m ? [Number(m[1]), m[2]] : null
}

// ---- Shape: what core can style ----

type Kind = "color" | "length" | "lineHeight" | "font"
interface Node {
  kind?: Kind
  children?: Record<string, Node>
  each?: Node
}

const color: Node = { kind: "color" }
const length: Node = { kind: "length" }
const palette: Node = { each: color }
const blockPalette: Node = { each: { children: { text: color, background: color } } }
const SCHEMA: Node = {
  children: {
    colors: { children: { light: palette, dark: palette } },
    blockColors: { children: { light: blockPalette, dark: blockPalette } },
    typography: {
      children: {
        fontFamily: { each: { kind: "font" } },
        fontSize: { each: length },
        lineHeight: { each: { kind: "lineHeight" } },
      },
    },
    layout: { each: length },
    spacing: { each: length },
    radius: { each: length },
  },
}

const MESSAGES = {
  notObject: "must be a JSON object",
  group: "must be an object",
  unknown: "this theme doesn't declare this token",
  number: "must be a number",
  lineHeight: "must be a number from 1 to 2.5",
  string: "must be a string",
  color: "must be a colour like #1b7760",
  length: "must be a length (px, rem, em, %, vw) or clamp() of lengths",
  font: "must be one of the theme's font options or a system font",
} as const

const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const join = (path: string, key: string) => (path ? `${path}.${key}` : key)
// Code-unit order, as Go's sort.Strings: both validators name the same first error.
const sortedKeys = (object: object) => Object.keys(object).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

class StyleError {
  constructor(
    readonly code: GlobalStyleErrorCode,
    readonly path: string,
    readonly message: string,
  ) {}
}

function leaf(kind: Kind, value: unknown, path: string, fonts: Set<string>): unknown {
  const invalid = (message: string) => new StyleError("invalid_value", path, message)
  if (kind === "lineHeight") {
    if (typeof value !== "number") throw invalid(MESSAGES.number)
    if (!isLineHeight(value)) throw invalid(MESSAGES.lineHeight)
    return value
  }
  if (typeof value !== "string") throw invalid(MESSAGES.string)
  if (kind === "color") {
    const normalized = normalizeColor(value)
    if (normalized === null) throw invalid(MESSAGES.color)
    return normalized
  }
  if (kind === "length") {
    const normalized = normalizeLength(value)
    if (normalized === null) throw invalid(MESSAGES.length)
    return normalized
  }
  if (!fonts.has(value)) throw invalid(MESSAGES.font)
  return value
}

function walk(input: Record<string, unknown>, node: Node, declared: Record<string, unknown>, path: string, fonts: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of sortedKeys(input)) {
    const keyPath = join(path, key)
    const child = node.children ? (own(node.children, key) ? node.children[key] : undefined) : node.each
    const declaredValue = own(declared, key) ? declared[key] : undefined
    if (!child || declaredValue === undefined || declaredValue === null) throw new StyleError("unknown_token", keyPath, MESSAGES.unknown)
    const value = input[key]
    if (!child.kind) {
      if (!isObject(value)) throw new StyleError("invalid_value", keyPath, MESSAGES.group)
      if (!isObject(declaredValue)) throw new StyleError("unknown_token", keyPath, MESSAGES.unknown)
      const nested = walk(value, child, declaredValue, keyPath, fonts)
      if (Object.keys(nested).length > 0) out[key] = nested
      continue
    }
    if (isObject(declaredValue)) throw new StyleError("unknown_token", keyPath, MESSAGES.unknown)
    out[key] = leaf(child.kind, value, keyPath, fonts)
  }
  return out
}

// a ≤ b when both are plain lengths in one unit; anything else can't be compared and passes.
function lengthAtMost(a: string, b: string): boolean {
  const [x, y] = [simpleLength(a), simpleLength(b)]
  if (!x || !y || x[1] !== y[1]) return true
  return x[0] <= y[0]
}

function spacingSteps(declared: Record<string, unknown>): [string, string][] {
  const steps: number[] = []
  for (const key of Object.keys(declared)) {
    if (!/^-?\d+$/.test(key) || String(Number(key)) !== key) return []
    steps.push(Number(key))
  }
  steps.sort((a, b) => a - b)
  return steps.slice(1).map((step, i) => [String(steps[i]), String(step)])
}

/**
 * 6.1's rules on the override merged with the theme's defaults: contentWidth ≤ wideWidth ≤
 * container, and each spacing step at least the one before. Only pairs the override touches.
 */
function checkOrder(override: Record<string, unknown>, declared: DeclaredTokens): void {
  const check = (group: string, pairs: [string, string][], message: (a: string, b: string) => string) => {
    const overrideGroup = isObject(override[group]) ? override[group] : {}
    const declaredGroup = isObject(declared[group]) ? declared[group] : {}
    if (Object.keys(overrideGroup).length === 0) return
    const merged = (key: string) => {
      const value = own(overrideGroup, key) ? overrideGroup[key] : own(declaredGroup, key) ? declaredGroup[key] : undefined
      return typeof value === "string" ? value : null
    }
    for (const [a, b] of pairs) {
      const [setA, setB] = [own(overrideGroup, a), own(overrideGroup, b)]
      if (!setA && !setB) continue
      const [va, vb] = [merged(a), merged(b)]
      if (va === null || vb === null || lengthAtMost(va, vb)) continue
      throw new StyleError("token_order", `${group}.${setA ? a : b}`, message(a, b))
    }
  }
  check(
    "layout",
    [
      ["contentWidth", "wideWidth"],
      ["wideWidth", "container"],
      ["contentWidth", "container"],
    ],
    (a, b) => `${a} must be at most ${b}`,
  )
  check("spacing", spacingSteps(isObject(declared.spacing) ? declared.spacing : {}), (a, b) => `spacing ${a} must be at most spacing ${b}`)
}

/**
 * Checks an override against a theme and returns it normalized (colours lowercased, clamp()
 * spaced, empty groups dropped), or the first problem: its code, dotted path and message,
 * exactly as the API answers it (400 unknown_token / invalid_value / token_order).
 */
export function validateGlobalStyles(input: unknown, theme: GlobalStylesTheme): GlobalStylesResult {
  if (!isObject(input)) return { ok: false, code: "invalid_value", path: "", message: MESSAGES.notObject }
  const fonts = new Set([...Object.keys(SYSTEM_FONT_STACKS), ...(theme.fontOptions ?? []).map((option) => option.id)])
  try {
    const styles = walk(input, SCHEMA, theme.tokens, "", fonts)
    checkOrder(styles, theme.tokens)
    return { ok: true, styles }
  } catch (error) {
    if (error instanceof StyleError) return { ok: false, code: error.code, path: error.path, message: `${error.path}: ${error.message}` }
    throw error
  }
}

// ---- Groups: what an activity entry or a release records, and per-group reset (9) ----

/** The parts of an override, in display order. Type scale is font sizes and line heights. */
export const GLOBAL_STYLE_GROUPS: readonly { name: string; path: readonly string[] }[] = [
  { name: "colors", path: ["colors"] },
  { name: "blockColors", path: ["blockColors"] },
  { name: "fonts", path: ["typography", "fontFamily"] },
  { name: "typeScale", path: ["typography", "fontSize"] },
  { name: "typeScale", path: ["typography", "lineHeight"] },
  { name: "layout", path: ["layout"] },
  { name: "spacing", path: ["spacing"] },
  { name: "radius", path: ["radius"] },
]

function subtree(styles: unknown, path: readonly string[]): unknown {
  let current = styles
  for (const key of path) current = isObject(current) && own(current, key) ? current[key] : undefined
  return isObject(current) && Object.keys(current).length === 0 ? undefined : current
}

function sameValue(a: unknown, b: unknown): boolean {
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => own(b, key) && sameValue(a[key], b[key]))
  }
  return a === b
}

/** The groups whose values differ between two overrides (names only, never values). */
export function changedGlobalStyleGroups(before: unknown, after: unknown): string[] {
  const groups: string[] = []
  for (const { name, path } of GLOBAL_STYLE_GROUPS) {
    if (groups.includes(name)) continue
    if (!sameValue(subtree(before, path), subtree(after, path))) groups.push(name)
  }
  return groups
}

// ---- Contrast (6.3): a warning, never a refusal ----

export const CONTRAST_TEXT = 4.5 // AA, normal text
export const CONTRAST_UI = 3 // AA, control edges and focus indicators

/**
 * [foreground, background, minimum] by the theme's colour names: every pairing the default
 * theme's theme.css uses for text, controls and callouts (its tokens.test.ts checks this
 * list). A pair naming a colour a theme doesn't declare is skipped.
 */
export const CONTRAST_PAIRS: readonly (readonly [string, string, number])[] = [
  ["text", "background", CONTRAST_TEXT],
  ["text", "surface", CONTRAST_TEXT],
  ["text", "surface2", CONTRAST_TEXT],
  ["text", "highlight", CONTRAST_TEXT], // search matches, and highlighted text (#418) with links in it
  ["textMuted", "background", CONTRAST_TEXT],
  ["textMuted", "surface", CONTRAST_TEXT],
  ["textMuted", "surface2", CONTRAST_TEXT],
  ["secondary", "background", CONTRAST_TEXT],
  ["secondary", "surface", CONTRAST_TEXT],
  ["secondary", "surface2", CONTRAST_TEXT], // inline code
  ["secondary", "primarySubtle", CONTRAST_TEXT], // the chosen theme in the header menu
  ["primary", "background", CONTRAST_TEXT], // links, eyebrows
  ["primary", "surface", CONTRAST_TEXT],
  ["primaryHover", "background", CONTRAST_TEXT],
  ["onPrimary", "primary", CONTRAST_TEXT], // primary buttons, skip link, a checked to-do's tick
  ["onPrimary", "primaryHover", CONTRAST_TEXT],
  ["borderStrong", "background", CONTRAST_UI], // outline buttons
  ["focus", "background", CONTRAST_UI],
  ["focus", "surface", CONTRAST_UI],
  // Callouts (#419): the page's text on each fill, links in it, and the tone's icon (a
  // graphic, so 3:1) on its fill.
  ["text", "infoBg", CONTRAST_TEXT],
  ["text", "successBg", CONTRAST_TEXT],
  ["text", "warningBg", CONTRAST_TEXT],
  ["text", "dangerBg", CONTRAST_TEXT],
  ["primary", "infoBg", CONTRAST_TEXT],
  ["primary", "successBg", CONTRAST_TEXT],
  ["primary", "warningBg", CONTRAST_TEXT],
  ["primary", "dangerBg", CONTRAST_TEXT],
  ["info", "infoBg", CONTRAST_UI],
  ["success", "successBg", CONTRAST_UI],
  ["warning", "warningBg", CONTRAST_UI],
  ["danger", "dangerBg", CONTRAST_UI],
  // To-do checkboxes (#419): the box edge on a card.
  ["borderStrong", "surface", CONTRAST_UI],
]

/** The page surfaces tinted block text (#356) must read on. */
export const BLOCK_COLOR_SURFACES = ["background", "surface", "surface2"] as const

/** One pair below its minimum. Block colours by path: `blockColors.red.text` on `surface`. */
export interface ContrastFailure {
  palette: "light" | "dark"
  foreground: string
  background: string
  ratio: number
  minimum: number
}

/** `light:text/surface`, as the vectors and the API name a pair. */
export const contrastFailureId = (f: ContrastFailure) => `${f.palette}:${f.foreground}/${f.background}`

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2's contrast ratio of two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function mergedPalette(declared: unknown, override: unknown): Record<string, string> {
  const palette: Record<string, string> = {}
  if (isObject(declared)) {
    for (const [key, value] of Object.entries(declared)) {
      const c = normalizeColor(value)
      if (c) palette[key] = c
    }
  }
  if (isObject(override)) {
    for (const [key, value] of Object.entries(override)) {
      const c = normalizeColor(value)
      if (c && own(palette, key)) palette[key] = c
    }
  }
  return palette
}

const at = (root: unknown, ...path: string[]): unknown => path.reduce<unknown>((current, key) => (isObject(current) && own(current, key) ? current[key] : undefined), root)
const round = (ratio: number) => Math.round(ratio * 100) / 100

/**
 * The pairs that fail with `styles` applied to the theme's colours: light then dark, in
 * CONTRAST_PAIRS order, then block colours by token name (each as text on every page
 * surface, and the page's text on its fill).
 */
export function contrastFailures(theme: GlobalStylesTheme, styles: unknown): ContrastFailure[] {
  const failures: ContrastFailure[] = []
  for (const name of ["light", "dark"] as const) {
    const colors = mergedPalette(at(theme.tokens, "colors", name), at(styles, "colors", name))
    for (const [fg, bg, minimum] of CONTRAST_PAIRS) {
      if (!own(colors, fg) || !own(colors, bg)) continue
      const ratio = contrastRatio(colors[fg], colors[bg])
      if (ratio < minimum) failures.push({ palette: name, foreground: fg, background: bg, ratio: round(ratio), minimum })
    }
    const declaredBlocks = at(theme.tokens, "blockColors", name)
    if (!isObject(declaredBlocks)) continue
    for (const token of sortedKeys(declaredBlocks)) {
      const block = mergedPalette(declaredBlocks[token], at(styles, "blockColors", name, token))
      if (own(block, "text")) {
        for (const surface of BLOCK_COLOR_SURFACES) {
          if (!own(colors, surface)) continue
          const ratio = contrastRatio(block.text, colors[surface])
          if (ratio < CONTRAST_TEXT) failures.push({ palette: name, foreground: `blockColors.${token}.text`, background: surface, ratio: round(ratio), minimum: CONTRAST_TEXT })
        }
      }
      if (own(block, "background") && own(colors, "text")) {
        const ratio = contrastRatio(colors.text, block.background)
        if (ratio < CONTRAST_TEXT) failures.push({ palette: name, foreground: "text", background: `blockColors.${token}.background`, ratio: round(ratio), minimum: CONTRAST_TEXT })
      }
    }
  }
  return failures
}

// ---- The API's token manifest (web/themes/tokens.manifest.json) ----

const TOKEN_GROUPS = ["colors", "blockColors", "typography", "layout", "spacing", "radius"] as const

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined)
  if (!isObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of sortedKeys(value)) if (value[key] !== undefined) out[key] = withoutUndefined(value[key])
  return out
}

/** A theme config's declared tokens with their defaults: its token groups, as they are. */
export function declaredTokens(config: object): DeclaredTokens {
  const source = config as Record<string, unknown>
  const tokens: DeclaredTokens = {}
  for (const group of TOKEN_GROUPS) if (source[group] !== undefined) tokens[group] = withoutUndefined(source[group])
  return tokens
}

export interface ThemeTokenManifestEntry {
  supports_global_styles: boolean
  tokens: DeclaredTokens
  font_options: FontOption[]
}

/**
 * The manifest the API validates overrides with: every theme whose config declares
 * colours, keyed by slug. `configs` maps a theme's slug to its theme.config.ts export.
 */
export function themeTokenManifest(configs: Record<string, object>): { manifest_version: 1; themes: Record<string, ThemeTokenManifestEntry> } {
  const themes: Record<string, ThemeTokenManifestEntry> = {}
  for (const slug of sortedKeys(configs)) {
    const config = configs[slug] as { colors?: unknown; supports?: { globalStyles?: unknown }; fontOptions?: FontOption[] }
    if (!isObject(config.colors)) continue
    themes[slug] = {
      supports_global_styles: config.supports?.globalStyles === true,
      tokens: declaredTokens(config),
      font_options: (config.fontOptions ?? []).map(({ id, label, stack }) => ({ id, label, stack })),
    }
  }
  return { manifest_version: 1, themes }
}

/** The manifest file's text: stable key order, two-space indent, a final newline. */
export const tokenManifestText = (manifest: object) => JSON.stringify(manifest, null, 2) + "\n"
