import { apiCall } from "../api"
import type { PluginCapability, PluginHook, PluginSettingSpec } from "@gl-admin/lib/plugins/manifest"

// The plugin registry (#455) and plugin settings (#457): api/plugins_*.go. Every route
// here but /plugins/enabled is admin only (requireSiteAdmin). Plugins have their own
// thin client and never share ThemeSettingsImpl, whose routes are public.

export type PluginStatus = "installed" | "missing" | "incompatible"

export interface Plugin {
  id: number
  slug: string
  name: string
  version: string
  author: string
  description: string
  // installed | missing (gone from the build, row kept) | incompatible.
  status: PluginStatus
  // For an incompatible plugin: outside core's plugin_api range, or plugin.json stopped
  // validating (the fields are then from its last valid one).
  incompatible_reason?: "plugin_api" | "invalid_manifest"
  // The admin's choice, kept while missing or incompatible; `active` is whether it
  // applies now (enabled and installed).
  enabled: boolean
  active: boolean
  enabled_at: string | null
  enabled_by: number | null
  installed_at: string
  changed_at: string
  content_hash: string
  plugin_api: number
  capabilities: PluginCapability[]
  blocks: string[]
  hooks: PluginHook[]
  has_settings: boolean
}

export interface PluginList {
  plugins: Plugin[]
  count: number
  plugin_api: { min: number; max: number }
}

export async function listPlugins(): Promise<PluginList> {
  return apiCall("/plugins")
}

const pluginPath = (slug: string) => `/plugins/${encodeURIComponent(slug)}`

export async function enablePlugin(slug: string): Promise<Plugin> {
  const rsp = await apiCall(`${pluginPath(slug)}/enable`, { method: "POST" })
  return rsp.plugin
}

export async function disablePlugin(slug: string): Promise<Plugin> {
  const rsp = await apiCall(`${pluginPath(slug)}/disable`, { method: "POST" })
  return rsp.plugin
}

// One field of the settings form: the manifest's spec and its name. `default` is null
// when the manifest declares none.
export type PluginSettingField = Omit<PluginSettingSpec, "default"> & { name: string; default?: PluginSettingSpec["default"] | null }

// A stored scalar, or a secret's state: the API never returns a secret's value.
export type PluginSecretState = { set: boolean }
export type PluginSettingValue = string | number | boolean

export interface PluginSettings {
  // Sorted by name.
  fields: PluginSettingField[]
  // What is stored and valid; a field missing here uses its default. A secret field is
  // always present, as { set }.
  values: Record<string, PluginSettingValue | PluginSecretState>
}

export async function getPluginSettings(slug: string): Promise<PluginSettings> {
  return apiCall(`${pluginPath(slug)}/settings`)
}

// values names only the fields to change: a value sets it, null clears it (the default
// applies again). A field left out is kept, which is how a saved secret stays.
export async function updatePluginSettings(slug: string, values: Record<string, PluginSettingValue | null>): Promise<PluginSettings> {
  return apiCall(`${pluginPath(slug)}/settings`, { method: "PUT", body: { values } })
}

// "Delete plugin data": this plugin's saved settings and nothing else (design 4.4).
export async function deletePluginData(slug: string): Promise<{ deleted: number }> {
  return apiCall(`${pluginPath(slug)}/settings`, { method: "DELETE" })
}
