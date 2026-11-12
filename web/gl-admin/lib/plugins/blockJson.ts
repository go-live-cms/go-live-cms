import { ATTR_NAME, attrProblem, RESERVED_ATTR, type ThemeAttrSpec } from "../blocks-spec/themeBlocks"
import { THEME_BLOCK_CONTENT_NAMES } from "../theme-blocks/installed"

// A plugin block's block.json (#456, docs/design/plugin-system.md 5.1): the exact inputs of
// `defineThemeBlock` (theme-blocks/define.ts) as data, so the collab server bundles no plugin
// JavaScript (rule 13) and the API validates the same file without running anything. Same
// attr vocabulary, same reserved names, same text-only `content` limit
// (THEME_BLOCK_CONTENT_NAMES) as a theme block's index.ts.
//
//   { "type": "plugin:reading-time/estimate", "version": 1, "title": "Reading time",
//     "content": "", "attrs": { "label": { "type": "string", "default": "min read", "maxLength": 40 } } }
//
// One validator in Go (api/plugin_blocks.go) and this twin must accept and refuse the same
// files: pluginBlockVectors.json holds the cases both suites run, and both report the first
// problem with the same field path (the plugin.json validator's pattern, manifest.ts).

export interface PluginBlockJson {
  type: string
  version: number
  title: string
  content?: string
  marks?: string
  attrs?: Record<string, ThemeAttrSpec>
}

export type PluginBlockJsonResult = { ok: true; block: PluginBlockJson } | { ok: false; field: string; message: string }

type Problem = { field: string; message: string }
type JsonObject = Record<string, unknown>

const BLOCK_FIELDS = ["attrs", "content", "marks", "title", "type", "version"]
const ATTR_FIELDS: Record<string, string[]> = {
  string: ["default", "enum", "maxLength", "type"],
  number: ["default", "enum", "integer", "maximum", "minimum", "type"],
  boolean: ["default", "type"],
}
// Names ProseMirror reads in a content or marks expression: letters, digits, `_`, `-`.
const NAME_TOKEN = /[A-Za-z_][\w-]*/g
// Whitespace is ASCII and spelled out: JS's \s also matches Unicode spaces, Go's doesn't, and
// both validators must refuse the same files.
const EXPRESSION_RE = /^[A-Za-z0-9_\- \t\n\r|*+?(){},]*$/
const MARKS_RE = /^[A-Za-z0-9_ \t\n\r]*$/

export const PLUGIN_BLOCK_LIMITS = {
  title: 100,
  version: 1_000_000,
  attrs: 50,
  enum: 100,
  expression: 200,
  maxLength: 100_000,
} as const

/**
 * The type a block directory must declare: `plugin:<slug>/<dir lowercased>`. plugin.json's
 * `blocks` names are unique ignoring case for exactly this reason (manifest.ts).
 */
export const pluginBlockTypeFor = (slug: string, dir: string): string => `plugin:${slug}/${dir.toLowerCase()}`

/** Validates a parsed block.json of `plugins/<slug>/blocks/<dir>/`. */
export function validatePluginBlockJson(value: unknown, slug: string, dir: string): PluginBlockJsonResult {
  const problem = blockProblem(value, slug, dir)
  if (problem) return { ok: false, ...problem }
  return { ok: true, block: value as PluginBlockJson }
}

function blockProblem(value: unknown, slug: string, dir: string): Problem | null {
  if (!isObject(value)) return problem("", "must be a JSON object")
  const unknown = unknownField(value, BLOCK_FIELDS, "", "is not a block.json field")
  if (unknown) return unknown

  if (!has(value, "type")) return problem("type", "is required")
  const expected = pluginBlockTypeFor(slug, dir)
  if (value.type !== expected) return problem("type", `must be "${expected}" (plugin:<plugin id>/<directory name in lowercase>)`)

  if (!has(value, "version")) return problem("version", "is required")
  const version = value.version
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > PLUGIN_BLOCK_LIMITS.version) {
    return problem("version", `must be an integer from 1 to ${PLUGIN_BLOCK_LIMITS.version}`)
  }

  if (!has(value, "title")) return problem("title", "is required")
  const title = value.title
  if (typeof title !== "string") return problem("title", "must be a string")
  if (isBlank(title)) return problem("title", "must not be blank")
  if (charCount(title) > PLUGIN_BLOCK_LIMITS.title) return problem("title", `must be at most ${PLUGIN_BLOCK_LIMITS.title} characters`)

  if (has(value, "content")) {
    const content = value.content
    if (typeof content !== "string") return problem("content", "must be a string")
    if (content.length > PLUGIN_BLOCK_LIMITS.expression || !EXPRESSION_RE.test(content)) {
      return problem("content", `must be a ProseMirror content expression, at most ${PLUGIN_BLOCK_LIMITS.expression} characters`)
    }
    const allowed = new Set<string>(THEME_BLOCK_CONTENT_NAMES)
    const refused = (content.match(NAME_TOKEN) ?? []).filter((name) => !allowed.has(name))
    if (refused.length > 0) {
      return problem("content", `may only name ${THEME_BLOCK_CONTENT_NAMES.join(", ")} (a plugin block holds text only), not ${refused[0]}`)
    }
  }

  if (has(value, "marks")) {
    const marks = value.marks
    if (typeof marks !== "string") return problem("marks", "must be a string")
    if (marks.length > PLUGIN_BLOCK_LIMITS.expression || !MARKS_RE.test(marks)) {
      return problem("marks", `must be mark names separated by spaces, or _, at most ${PLUGIN_BLOCK_LIMITS.expression} characters`)
    }
  }

  return attrsProblem(value.attrs)
}

function attrsProblem(value: unknown): Problem | null {
  if (value === undefined) return null
  if (!isObject(value)) return problem("attrs", "must be an object")
  const names = sortedKeys(value)
  if (names.length > PLUGIN_BLOCK_LIMITS.attrs) return problem("attrs", `must have at most ${PLUGIN_BLOCK_LIMITS.attrs} attrs`)
  for (const name of names) {
    const field = `attrs.${name}`
    if (!ATTR_NAME.test(name) || RESERVED_ATTR.test(name)) {
      return problem(field, "must be letters and digits, start with a letter, and not be pm, text or on…")
    }
    const attr = value[name]
    if (!isObject(attr)) return problem(field, "must be an object")
    if (!has(attr, "type")) return problem(`${field}.type`, "is required")
    const type = attr.type
    if (typeof type !== "string" || !has(ATTR_FIELDS, type)) return problem(`${field}.type`, "must be string, number or boolean")
    const unknown = unknownField(attr, ATTR_FIELDS[type], `${field}.`, `is not a ${type} attr field`)
    if (unknown) return unknown
    const found = attrFieldsProblem(field, type, attr)
    if (found) return found
  }
  return null
}

function attrFieldsProblem(field: string, type: string, attr: JsonObject): Problem | null {
  if (type === "number") {
    if (has(attr, "integer") && typeof attr.integer !== "boolean") return problem(`${field}.integer`, "must be true or false")
    for (const key of ["minimum", "maximum"]) {
      if (has(attr, key) && !isFiniteNumber(attr[key])) return problem(`${field}.${key}`, "must be a number")
    }
    if (isFiniteNumber(attr.minimum) && isFiniteNumber(attr.maximum) && attr.minimum > attr.maximum) {
      return problem(`${field}.maximum`, "must not be less than minimum")
    }
  }
  if (type === "string" && has(attr, "maxLength")) {
    const max = attr.maxLength
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > PLUGIN_BLOCK_LIMITS.maxLength) {
      return problem(`${field}.maxLength`, `must be an integer from 1 to ${PLUGIN_BLOCK_LIMITS.maxLength}`)
    }
  }
  if (has(attr, "enum")) {
    const values = attr.enum
    if (!Array.isArray(values) || values.length === 0 || values.length > PLUGIN_BLOCK_LIMITS.enum) {
      return problem(`${field}.enum`, `must be an array of 1 to ${PLUGIN_BLOCK_LIMITS.enum} values`)
    }
    const seen = new Set<unknown>()
    for (const [i, item] of values.entries()) {
      const ok = type === "string" ? typeof item === "string" : isFiniteNumber(item)
      if (!ok) return problem(`${field}.enum[${i}]`, `must be a ${type}`)
      if (seen.has(item)) return problem(`${field}.enum[${i}]`, "is listed twice")
      seen.add(item)
    }
  }
  if (!has(attr, "default") || attr.default === null) return problem(`${field}.default`, "is required")
  if (attrProblem(attr as unknown as ThemeAttrSpec, attr.default) !== null) {
    return problem(`${field}.default`, "must be a valid value of the attr")
  }
  return null
}

function problem(field: string, message: string): Problem {
  return { field, message }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function has(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

/** Byte order, as Go's sort.Strings over the keys. */
function sortedKeys(object: JsonObject): string[] {
  return Object.keys(object).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function unknownField(object: JsonObject, allowed: string[], prefix: string, message: string): Problem | null {
  for (const key of sortedKeys(object)) {
    if (!allowed.includes(key)) return problem(prefix + key, message)
  }
  return null
}

/** Characters as Go counts runes (code points), not UTF-16 units. */
function charCount(s: string): number {
  return [...s].length
}

/** Only ASCII whitespace, as the Go side trims. */
function isBlank(s: string): boolean {
  return s.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "") === ""
}
