// plugin.json validation (#455, docs/design/plugin-system.md section 3).
//
// The twin of the API's validator (api/plugins_manifest.go), which is the one that
// decides: the startup scan registers what it accepts. This copy exists so the web side
// (the build's plugin globs, #456; the Plugins page, #11) reads manifests by the same
// rules. pluginManifestVectors.json holds the cases both suites run; checks run in the
// same fixed order and report the first problem with the same `field` path, so a case
// can't pass on one side and fail on the other. Keep the limits equal to the Go ones.
//
// Import-free on purpose: no editor, Block Spec or collab code, so the build scripts and
// the collab bundle can use it without pulling anything in.

/** Core's plugin_api range (Go: PluginAPIMin, PluginAPIMax). */
export const PLUGIN_API = { min: 1, max: 1 } as const

export const PLUGIN_CAPABILITIES = ["posts:read", "media:read", "users:read", "network"] as const
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number]

const GUARD_EVENT = "post.before_publish"
export const PLUGIN_HOOK_EVENTS = [
  "post.saved",
  "post.published",
  "post.unpublished",
  "post.trashed",
  "post.restored",
  "post.deleted",
  GUARD_EVENT,
] as const
export type PluginHookEvent = (typeof PLUGIN_HOOK_EVENTS)[number]

const ID_RE = /^[a-z][a-z0-9-]{0,62}$/
const BLOCK_NAME_RE = /^[A-Z][A-Za-z0-9]{0,63}$/
const SETTING_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/
// Semantic Versioning 2.0.0's own expression (semver.org).
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** `enabled` is GET /plugins/enabled, which would hide GET /plugins/:slug. */
const RESERVED_IDS = new Set(["enabled"])

const LIMITS = {
  name: 100,
  author: 100,
  description: 1000,
  version: 64,
  blocks: 50,
  settings: 50,
  enum: 100,
  settingLabel: 100,
  settingDescription: 500,
  maxLength: 10000,
  hooks: 16,
  hookTimeout: 30000,
  guardPriority: 1000,
  pluginApi: 1000000,
}

export type PluginSettingType = "string" | "number" | "boolean"

export interface PluginSettingSpec {
  type: PluginSettingType
  default?: string | number | boolean
  enum?: (string | number)[]
  maxLength?: number
  integer?: boolean
  minimum?: number
  maximum?: number
  label?: string
  description?: string
  secret?: boolean
}

export interface PluginHook {
  event: PluginHookEvent
  timeout_ms?: number
  on_error?: "allow" | "deny"
  priority?: number
}

export interface PluginManifest {
  manifest_version: 1
  id: string
  name: string
  version: string
  author?: string
  description?: string
  plugin_api: number
  capabilities?: PluginCapability[]
  blocks?: string[]
  settings?: Record<string, PluginSettingSpec>
  server?: { hooks?: PluginHook[] }
}

export type PluginManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; field: string; message: string }

type Problem = { field: string; message: string }
type JsonObject = Record<string, unknown>

const MANIFEST_FIELDS = [
  "manifest_version", "id", "name", "version", "author", "description", "plugin_api",
  "capabilities", "blocks", "settings", "server",
]
const SETTING_FIELDS = [
  "type", "default", "enum", "maxLength", "integer", "minimum", "maximum", "label", "description", "secret",
]
const SETTING_TYPE_FIELDS: Record<PluginSettingType, string[]> = {
  string: ["enum", "maxLength", "secret"],
  number: ["enum", "integer", "minimum", "maximum"],
  boolean: [],
}
const SERVER_FIELDS = ["hooks"]
const HOOK_FIELDS = ["event", "timeout_ms", "on_error", "priority"]

/** Whether a manifest's plugin_api is in core's range (else: incompatible). */
export function pluginApiCompatible(api: number): boolean {
  return api >= PLUGIN_API.min && api <= PLUGIN_API.max
}

/** Validates a parsed plugin.json as the manifest of directory `dir`. */
export function validatePluginManifest(value: unknown, dir: string): PluginManifestResult {
  const problem = manifestProblem(value, dir)
  if (problem) return { ok: false, ...problem }
  return { ok: true, manifest: value as PluginManifest }
}

function manifestProblem(value: unknown, dir: string): Problem | null {
  if (!isObject(value)) return problem("", "must be a JSON object")
  const unknown = unknownField(value, MANIFEST_FIELDS, "", "is not a manifest field")
  if (unknown) return unknown

  if (!has(value, "manifest_version")) return problem("manifest_version", "is required")
  if (value.manifest_version !== 1) return problem("manifest_version", "must be 1")

  const id = requiredString(value, "id")
  if (typeof id !== "string") return id
  if (!ID_RE.test(id)) {
    return problem("id", "must be lowercase letters, digits and hyphens, start with a letter, at most 63 characters")
  }
  if (RESERVED_IDS.has(id)) return problem("id", "is reserved")
  if (id !== dir) return problem("id", `must equal the plugin's directory name (${dir})`)

  const name = requiredString(value, "name")
  if (typeof name !== "string") return name
  if (isBlank(name)) return problem("name", "must not be blank")
  if (charCount(name) > LIMITS.name) return problem("name", `must be at most ${LIMITS.name} characters`)

  const version = requiredString(value, "version")
  if (typeof version !== "string") return version
  if (version.length > LIMITS.version || !SEMVER_RE.test(version)) {
    return problem("version", `must be a semantic version (1.2.0), at most ${LIMITS.version} characters`)
  }

  const optional =
    optionalString(value, "author", LIMITS.author, "") ??
    optionalString(value, "description", LIMITS.description, "")
  if (optional) return optional

  if (!has(value, "plugin_api")) return problem("plugin_api", "is required")
  const api = value.plugin_api
  if (typeof api !== "number" || !Number.isInteger(api) || api < 1 || api > LIMITS.pluginApi) {
    return problem("plugin_api", `must be an integer from 1 to ${LIMITS.pluginApi}`)
  }

  return (
    capabilitiesProblem(value.capabilities) ??
    blocksProblem(value.blocks) ??
    settingsProblem(value.settings) ??
    serverProblem(value.server)
  )
}

function capabilitiesProblem(value: unknown): Problem | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) return problem("capabilities", "must be an array")
  const seen = new Set<string>()
  for (const [i, item] of value.entries()) {
    const field = `capabilities[${i}]`
    if (typeof item !== "string" || !(PLUGIN_CAPABILITIES as readonly string[]).includes(item)) {
      return problem(field, `must be one of ${PLUGIN_CAPABILITIES.join(", ")}`)
    }
    if (seen.has(item)) return problem(field, "is declared twice")
    seen.add(item)
  }
  return null
}

function blocksProblem(value: unknown): Problem | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) return problem("blocks", "must be an array")
  if (value.length > LIMITS.blocks) return problem("blocks", `must have at most ${LIMITS.blocks} entries`)
  const seen = new Set<string>()
  for (const [i, item] of value.entries()) {
    const field = `blocks[${i}]`
    if (typeof item !== "string" || !BLOCK_NAME_RE.test(item)) {
      return problem(field, "must be a block directory name: a capital letter, then letters and digits, at most 64 characters")
    }
    // Block types are derived from the names, so two differing only in case would collide.
    const key = item.toLowerCase()
    if (seen.has(key)) return problem(field, "is declared twice")
    seen.add(key)
  }
  return null
}

function settingsProblem(value: unknown): Problem | null {
  if (value === undefined || value === null) return null
  if (!isObject(value)) return problem("settings", "must be an object")
  const keys = sortedKeys(value)
  if (keys.length > LIMITS.settings) return problem("settings", `must have at most ${LIMITS.settings} fields`)
  for (const key of keys) {
    if (!SETTING_KEY_RE.test(key)) {
      return problem(`settings.${key}`, "must be lowercase letters, digits and underscores, start with a letter, at most 64 characters")
    }
    const found = settingProblem(`settings.${key}`, value[key])
    if (found) return found
  }
  return null
}

function settingProblem(field: string, value: unknown): Problem | null {
  if (!isObject(value)) return problem(field, "must be an object")
  const unknown = unknownField(value, SETTING_FIELDS, `${field}.`, "is not a setting field")
  if (unknown) return unknown
  const kind = value.type
  if (typeof kind !== "string" || !has(SETTING_TYPE_FIELDS, kind)) {
    return problem(`${field}.type`, "must be string, number or boolean")
  }
  const allowed = SETTING_TYPE_FIELDS[kind as PluginSettingType]
  for (const name of ["enum", "maxLength", "secret", "integer", "minimum", "maximum"]) {
    if (has(value, name) && !allowed.includes(name)) {
      return problem(`${field}.${name}`, `is not allowed for type ${kind}`)
    }
  }

  let integer = false
  if (has(value, "integer")) {
    if (typeof value.integer !== "boolean") return problem(`${field}.integer`, "must be a boolean")
    integer = value.integer
  }
  let enumValues: unknown[] | undefined
  if (has(value, "enum")) {
    const list = value.enum
    if (!Array.isArray(list) || list.length === 0 || list.length > LIMITS.enum) {
      return problem(`${field}.enum`, `must be an array of 1 to ${LIMITS.enum} values`)
    }
    for (const [i, item] of list.entries()) {
      const itemField = `${field}.enum[${i}]`
      if (kind === "string" && typeof item !== "string") return problem(itemField, "must be a string")
      if (kind === "number" && (typeof item !== "number" || (integer && !Number.isInteger(item)))) {
        return problem(itemField, "must be a number of the setting's kind")
      }
      if (list.indexOf(item) !== i) return problem(itemField, "is listed twice")
    }
    enumValues = list
  }
  let maxLength: number | undefined
  if (has(value, "maxLength")) {
    const n = value.maxLength
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > LIMITS.maxLength) {
      return problem(`${field}.maxLength`, `must be an integer from 1 to ${LIMITS.maxLength}`)
    }
    maxLength = n
  }
  const bounds: { minimum?: number; maximum?: number } = {}
  for (const name of ["minimum", "maximum"] as const) {
    if (!has(value, name)) continue
    const n = value[name]
    if (typeof n !== "number") return problem(`${field}.${name}`, "must be a number")
    bounds[name] = n
  }
  if (bounds.minimum !== undefined && bounds.maximum !== undefined && bounds.maximum < bounds.minimum) {
    return problem(`${field}.maximum`, "must be at least the minimum")
  }
  if (has(value, "secret") && typeof value.secret !== "boolean") {
    return problem(`${field}.secret`, "must be a boolean")
  }
  const text =
    optionalString(value, "label", LIMITS.settingLabel, `${field}.`) ??
    optionalString(value, "description", LIMITS.settingDescription, `${field}.`)
  if (text) return text
  if (has(value, "default")) {
    // The value rules a stored setting is checked with (Block Spec attrProblem; Go:
    // themeAttrProblem).
    const found = valueProblem(kind as PluginSettingType, { integer, enumValues, maxLength, ...bounds }, value.default)
    if (found) return problem(`${field}.default`, found)
  }
  return null
}

/** Block Spec `attrProblem` for a setting's value: null when valid. */
function valueProblem(
  kind: PluginSettingType,
  spec: { integer: boolean; enumValues?: unknown[]; maxLength?: number; minimum?: number; maximum?: number },
  value: unknown,
): string | null {
  switch (kind) {
    case "string":
      if (typeof value !== "string") return "must be a string"
      if (spec.enumValues && !spec.enumValues.includes(value)) return "must be one of the declared values"
      if (spec.maxLength !== undefined && charCount(value) > spec.maxLength) {
        return `must be at most ${spec.maxLength} characters`
      }
      return null
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number"
      if (spec.integer && !Number.isInteger(value)) return "must be an integer"
      if (spec.enumValues && !spec.enumValues.includes(value)) return "must be one of the declared values"
      if (spec.minimum !== undefined && value < spec.minimum) return `must be at least ${spec.minimum}`
      if (spec.maximum !== undefined && value > spec.maximum) return `must be at most ${spec.maximum}`
      return null
    case "boolean":
      return typeof value === "boolean" ? null : "must be a boolean"
  }
}

function serverProblem(value: unknown): Problem | null {
  if (value === undefined || value === null) return null
  if (!isObject(value)) return problem("server", "must be an object")
  const unknown = unknownField(value, SERVER_FIELDS, "server.", "is not a server field")
  if (unknown) return unknown
  const hooks = value.hooks
  if (hooks === undefined || hooks === null) return null
  if (!Array.isArray(hooks)) return problem("server.hooks", "must be an array")
  if (hooks.length > LIMITS.hooks) return problem("server.hooks", `must have at most ${LIMITS.hooks} entries`)
  const seen = new Set<string>()
  for (const [i, hook] of hooks.entries()) {
    const field = `server.hooks[${i}]`
    if (!isObject(hook)) return problem(field, "must be an object")
    const unknownHook = unknownField(hook, HOOK_FIELDS, `${field}.`, "is not a hook field")
    if (unknownHook) return unknownHook
    const event = hook.event
    if (typeof event !== "string" || !(PLUGIN_HOOK_EVENTS as readonly string[]).includes(event)) {
      return problem(`${field}.event`, `must be one of ${PLUGIN_HOOK_EVENTS.join(", ")}`)
    }
    if (seen.has(event)) return problem(`${field}.event`, "is declared twice")
    seen.add(event)
    const guard = event === GUARD_EVENT

    if (has(hook, "timeout_ms")) {
      if (guard) return problem(`${field}.timeout_ms`, `is not allowed for ${GUARD_EVENT} (guards have a fixed budget)`)
      const n = hook.timeout_ms
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > LIMITS.hookTimeout) {
        return problem(`${field}.timeout_ms`, `must be an integer from 1 to ${LIMITS.hookTimeout}`)
      }
    }
    if (has(hook, "on_error")) {
      if (!guard) return problem(`${field}.on_error`, `is only allowed for ${GUARD_EVENT}`)
      if (hook.on_error !== "allow" && hook.on_error !== "deny") {
        return problem(`${field}.on_error`, "must be allow or deny")
      }
    }
    if (has(hook, "priority")) {
      if (!guard) return problem(`${field}.priority`, `is only allowed for ${GUARD_EVENT}`)
      const n = hook.priority
      if (typeof n !== "number" || !Number.isInteger(n) || Math.abs(n) > LIMITS.guardPriority) {
        return problem(`${field}.priority`, `must be an integer from -${LIMITS.guardPriority} to ${LIMITS.guardPriority}`)
      }
    }
  }
  return null
}

function problem(field: string, message: string): Problem {
  return { field, message }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function has(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

/** Keys in byte order, as Go's sort.Strings orders them (not localeCompare). */
function sortedKeys(object: JsonObject): string[] {
  return Object.keys(object).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function unknownField(object: JsonObject, allowed: string[], prefix: string, message: string): Problem | null {
  for (const key of sortedKeys(object)) {
    if (!allowed.includes(key)) return problem(prefix + key, message)
  }
  return null
}

function requiredString(object: JsonObject, key: string): string | Problem {
  if (!has(object, key)) return problem(key, "is required")
  const value = object[key]
  return typeof value === "string" ? value : problem(key, "must be a string")
}

function optionalString(object: JsonObject, key: string, max: number, prefix: string): Problem | null {
  if (!has(object, key)) return null
  const value = object[key]
  if (typeof value !== "string") return problem(prefix + key, "must be a string")
  if (charCount(value) > max) return problem(prefix + key, `must be at most ${max} characters`)
  return null
}

/** Characters as Go counts runes (code points), not UTF-16 units. */
function charCount(s: string): number {
  return [...s].length
}

/** Only ASCII whitespace, as the Go side trims (`\s` would mean more there than here). */
function isBlank(s: string): boolean {
  return s.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "") === ""
}
