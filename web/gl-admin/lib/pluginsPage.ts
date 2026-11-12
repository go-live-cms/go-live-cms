import type { Plugin, PluginSecretState, PluginSettingField, PluginSettings, PluginSettingValue } from "@gl-admin/lib/api/plugins"
import { PLUGIN_GUARD_EVENT } from "@gl-admin/lib/plugins/manifest"

// The Plugins page (#11, the redesign canvas's "Plugins" board) and its settings panel
// (#457): what a row shows and offers, what the confirmations say, and the settings
// form's draft. Pure, so it is tested without the page (pluginsPage.test.ts).

// What each declared capability means, for the list's chips and the enable dialog.
// Declared, shown, not enforced in Beta (docs/design/plugin-system.md section 2).
export const CAPABILITY_LABELS: Record<string, { name: string; description: string }> = {
  "posts:read": { name: "Read posts", description: "Drafts and published posts, by id." },
  "media:read": { name: "Read media", description: "Your media library’s details." },
  "users:read": { name: "Read members", description: "Names and roles. Never emails or passwords." },
  network: { name: "Connect to other services", description: "Makes requests to services outside your site." },
}

// A publish guard (post.before_publish, design 7.7) is shown beside the capabilities.
const GUARD = { name: "Can block publishing", description: "Can stop a post from going live, and says why." }

export type DeclaredUse = { name: string; description: string }

// What a plugin says it uses: its capabilities in the manifest's order, then the guard.
export function declaredUses(plugin: Pick<Plugin, "capabilities" | "hooks">): DeclaredUse[] {
  const uses = plugin.capabilities.map((c) => CAPABILITY_LABELS[c] ?? { name: c, description: "" })
  if (plugin.hooks.some((h) => h.event === PLUGIN_GUARD_EVENT)) uses.push(GUARD)
  return uses
}

// The pill beside the name for a plugin that isn't installed; null when it is.
export function statusLabel(plugin: Pick<Plugin, "status">): string | null {
  if (plugin.status === "missing") return "Not in this build"
  if (plugin.status === "incompatible") return "Incompatible"
  return null
}

// The line under the description that says why a plugin can't run.
export function statusNote(plugin: Pick<Plugin, "status" | "incompatible_reason" | "blocks">): string | null {
  if (plugin.status === "missing") {
    return plugin.blocks.length > 0
      ? "Missing from this build. Its blocks stay in your posts, hidden, until it comes back."
      : "Missing from this build. Its settings are kept until it comes back."
  }
  if (plugin.status === "incompatible") {
    return plugin.incompatible_reason === "invalid_manifest"
      ? "Its plugin.json no longer validates, so it can’t be enabled here."
      : "Written for a different plugin version, so it can’t be enabled here."
  }
  return null
}

export type PluginActions = {
  settings: boolean
  enable: boolean
  // Enable drawn but unavailable (an incompatible plugin).
  enableUnavailable: boolean
  disable: boolean
}

// The row's buttons. Disable works in any status (the API allows it, so a plugin that
// comes back stays off); Enable only for an installed one; Settings for an installed
// one that declares any (PUT refuses a missing or incompatible plugin).
export function pluginActions(plugin: Pick<Plugin, "status" | "enabled" | "has_settings">): PluginActions {
  return {
    settings: plugin.status === "installed" && plugin.has_settings,
    enable: plugin.status === "installed" && !plugin.enabled,
    enableUnavailable: plugin.status === "incompatible" && !plugin.enabled,
    disable: plugin.enabled,
  }
}

// The API's 409 codes for enable and settings writes.
export function pluginConflictMessage(code: string | null | undefined): string | null {
  switch (code) {
    case "plugin_missing":
      return "This plugin is no longer in this build."
    case "plugin_incompatible":
      return "This plugin isn’t compatible with this version of GoLive."
    case "plugin_not_found":
      return "This plugin is no longer registered."
    case "plugin_changed":
      return "This plugin changed meanwhile. Try again."
    default:
      return null
  }
}

// What the disable confirmation says. usedIn is the number of posts using the plugin's
// blocks (GET /plugins/:slug/usage, #456), or null while that isn't available.
export function disableSummary(plugin: Pick<Plugin, "blocks" | "hooks">, usedIn: number | null = null): { lead: string | null; body: string | null; after: string } {
  const lead = usedIn === null ? null : `Used in ${usedIn} ${usedIn === 1 ? "post" : "posts"}.`
  const body =
    plugin.blocks.length > 0
      ? "Its blocks stay as they are: they still edit and still show on your site. They just won’t be offered in the block menus."
      : null
  const after = plugin.hooks.length > 0 ? "Its server features stop running. Its settings are kept." : "Its settings are kept."
  return { lead: body ? lead : null, body, after }
}

// --- The settings form -------------------------------------------------------------

// A text or number field holds its text; a switch its state; a secret what's typed and
// whether a saved one is being replaced.
export type SecretDraft = { set: boolean; replacing: boolean; value: string }
export type FieldDraft = string | boolean | SecretDraft
export type SettingsDraft = Record<string, FieldDraft>

const isSecretState = (value: unknown): value is PluginSecretState =>
  typeof value === "object" && value !== null && "set" in value

// The value a field shows: what's stored, else the manifest's default.
function effectiveValue(field: PluginSettingField, settings: PluginSettings): PluginSettingValue | undefined {
  const stored = settings.values[field.name]
  if (stored !== undefined && !isSecretState(stored)) return stored
  // The API sends `default: null` for a field that declares none.
  return field.default ?? undefined
}

export function initialDraft(settings: PluginSettings): SettingsDraft {
  const draft: SettingsDraft = {}
  for (const field of settings.fields) {
    if (field.secret) {
      const state = settings.values[field.name]
      draft[field.name] = { set: isSecretState(state) && state.set, replacing: false, value: "" }
      continue
    }
    const value = effectiveValue(field, settings)
    draft[field.name] = field.type === "boolean" ? value === true : value === undefined ? "" : String(value)
  }
  return draft
}

// "Daily" for "daily", "Read later" for "read_later".
export function optionLabel(value: string | number): string {
  const text = String(value).replace(/[_-]+/g, " ").trim()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function fieldLabel(field: PluginSettingField): string {
  return field.label || optionLabel(field.name)
}

const chars = (s: string) => [...s].length

// Why a field's draft can't be saved, as the form says it (the API checks the same
// rules: themeAttrProblem). null when it's fine.
export function fieldProblem(field: PluginSettingField, draft: FieldDraft | undefined): string | null {
  if (field.secret) {
    const secret = draft as SecretDraft | undefined
    if (!secret || (secret.set && !secret.replacing) || secret.value === "") return null
    if (field.maxLength !== undefined && chars(secret.value) > field.maxLength) return `Use at most ${field.maxLength} characters.`
    return null
  }
  if (field.type === "boolean") return null
  const text = typeof draft === "string" ? draft : ""
  if (field.type === "string") {
    // "" is unset (a field with no default): the default applies, nothing to refuse.
    if (field.enum && text !== "" && !field.enum.includes(text)) return "Choose one of the options."
    if (field.maxLength !== undefined && chars(text) > field.maxLength) return `Use at most ${field.maxLength} characters.`
    return null
  }
  // number
  if (text.trim() === "") return null // empty = back to the default
  const n = Number(text)
  if (!Number.isFinite(n)) return "Enter a number."
  if (field.enum && !field.enum.includes(n)) return "Choose one of the options."
  const hasMin = field.minimum !== undefined
  const hasMax = field.maximum !== undefined
  const outOfRange = (hasMin && n < field.minimum!) || (hasMax && n > field.maximum!)
  if (field.integer && !Number.isInteger(n)) {
    return hasMin && hasMax ? `Enter a whole number from ${field.minimum} to ${field.maximum}.` : "Enter a whole number."
  }
  if (outOfRange) {
    if (hasMin && hasMax) return `Enter a number from ${field.minimum} to ${field.maximum}.`
    return hasMin ? `Enter a number of at least ${field.minimum}.` : `Enter a number of at most ${field.maximum}.`
  }
  return null
}

export function draftProblems(settings: PluginSettings, draft: SettingsDraft): Record<string, string> {
  const problems: Record<string, string> = {}
  for (const field of settings.fields) {
    const problem = fieldProblem(field, draft[field.name])
    if (problem) problems[field.name] = problem
  }
  return problems
}

// The PUT body: only the fields that changed. A cleared number field sends null (the
// default applies again); a secret is sent only when one is typed, so leaving it alone,
// or opening Replace and typing nothing, keeps the saved one.
export function settingsChanges(settings: PluginSettings, draft: SettingsDraft): Record<string, PluginSettingValue | null> {
  const changes: Record<string, PluginSettingValue | null> = {}
  const initial = initialDraft(settings)
  for (const field of settings.fields) {
    const now = draft[field.name]
    if (field.secret) {
      const secret = now as SecretDraft | undefined
      if (secret && (!secret.set || secret.replacing) && secret.value !== "") changes[field.name] = secret.value
      continue
    }
    if (now === undefined || now === initial[field.name]) continue
    if (field.type === "boolean") changes[field.name] = now === true
    else if (field.type === "number") changes[field.name] = (now as string).trim() === "" ? null : Number(now)
    else changes[field.name] = now as string
  }
  return changes
}
