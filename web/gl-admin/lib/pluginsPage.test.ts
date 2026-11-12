import { describe, expect, it } from "vitest"
import type { Plugin, PluginSettings } from "@gl-admin/lib/api/plugins"
import {
  declaredUses,
  disableSummary,
  draftProblems,
  fieldProblem,
  initialDraft,
  optionLabel,
  pluginActions,
  pluginConflictMessage,
  settingsChanges,
  statusLabel,
  statusNote,
  type SettingsDraft,
} from "./pluginsPage"

// The Plugins page's rules (#11) and the settings form's draft (#457).

export function plugin(over: Partial<Plugin> = {}): Plugin {
  return {
    id: 1,
    slug: "reading-time",
    name: "Reading time",
    version: "1.2.0",
    author: "Ana Costa",
    description: "Adds an estimated reading time block.",
    status: "installed",
    enabled: false,
    active: false,
    enabled_at: null,
    enabled_by: null,
    installed_at: "",
    changed_at: "",
    content_hash: "a".repeat(64),
    plugin_api: 1,
    capabilities: [],
    blocks: [],
    hooks: [],
    has_settings: false,
    ...over,
  }
}

const SETTINGS: PluginSettings = {
  fields: [
    { name: "api_key", type: "string", secret: true, maxLength: 8, label: "API key" },
    { name: "frequency", type: "string", enum: ["daily", "weekly"], default: "daily" },
    { name: "per_post", type: "number", integer: true, minimum: 1, maximum: 200, default: 50 },
    { name: "ratio", type: "number", minimum: 0 },
    { name: "skip_own", type: "boolean", default: true },
    { name: "title", type: "string", maxLength: 5, default: "Links" },
  ],
  values: { api_key: { set: true }, per_post: 120 },
}

describe("what a row shows", () => {
  it("lists the declared capabilities, then a publish guard", () => {
    const uses = declaredUses(plugin({ capabilities: ["posts:read", "network"], hooks: [{ event: "post.published" }, { event: "post.before_publish" }] }))
    expect(uses.map((u) => u.name)).toEqual(["Read posts", "Connect to other services", "Can block publishing"])
    expect(declaredUses(plugin()).length).toBe(0)
  })

  it("labels and explains a plugin that can't run", () => {
    expect(statusLabel(plugin())).toBeNull()
    expect(statusLabel(plugin({ status: "missing" }))).toBe("Not in this build")
    expect(statusLabel(plugin({ status: "incompatible" }))).toBe("Incompatible")
    expect(statusNote(plugin())).toBeNull()
    expect(statusNote(plugin({ status: "missing", blocks: ["Estimate"] }))).toContain("Its blocks stay in your posts")
    expect(statusNote(plugin({ status: "missing" }))).toContain("settings are kept")
    expect(statusNote(plugin({ status: "incompatible", incompatible_reason: "plugin_api" }))).toContain("different plugin version")
    expect(statusNote(plugin({ status: "incompatible", incompatible_reason: "invalid_manifest" }))).toContain("plugin.json")
  })

  it("offers what the API allows", () => {
    expect(pluginActions(plugin())).toEqual({ settings: false, enable: true, enableUnavailable: false, disable: false })
    expect(pluginActions(plugin({ enabled: true, active: true, has_settings: true }))).toEqual({ settings: true, enable: false, enableUnavailable: false, disable: true })
    // Not installed: no settings (PUT refuses them), no Enable; Disable while enabled.
    expect(pluginActions(plugin({ status: "missing", enabled: true, has_settings: true }))).toEqual({ settings: false, enable: false, enableUnavailable: false, disable: true })
    expect(pluginActions(plugin({ status: "missing" }))).toEqual({ settings: false, enable: false, enableUnavailable: false, disable: false })
    expect(pluginActions(plugin({ status: "incompatible" })).enableUnavailable).toBe(true)
  })

  it("words the API's conflicts", () => {
    expect(pluginConflictMessage("plugin_missing")).toContain("no longer in this build")
    expect(pluginConflictMessage("plugin_incompatible")).toContain("compatible")
    expect(pluginConflictMessage("plugin_changed")).toContain("Try again")
    expect(pluginConflictMessage(null)).toBeNull()
  })
})

describe("the disable confirmation", () => {
  it("says what happens to blocks, server features and settings", () => {
    const both = disableSummary(plugin({ blocks: ["Estimate"], hooks: [{ event: "post.saved" }] }))
    expect(both.body).toContain("they still edit and still show on your site")
    expect(both.after).toBe("Its server features stop running. Its settings are kept.")
    const neither = disableSummary(plugin())
    expect(neither.body).toBeNull()
    expect(neither.after).toBe("Its settings are kept.")
  })

  it("leads with the usage count only when there is one", () => {
    const withBlocks = plugin({ blocks: ["Estimate"] })
    expect(disableSummary(withBlocks).lead).toBeNull()
    expect(disableSummary(withBlocks, 14).lead).toBe("Used in 14 posts.")
    expect(disableSummary(withBlocks, 1).lead).toBe("Used in 1 post.")
  })
})

describe("the settings draft", () => {
  it("starts from what's stored, else the default; a secret only says whether it's set", () => {
    expect(initialDraft(SETTINGS)).toEqual({
      api_key: { set: true, replacing: false, value: "" },
      frequency: "daily",
      per_post: "120",
      ratio: "",
      skip_own: true,
      title: "Links",
    })
  })

  it("reads the API's null default as none", () => {
    const settings: PluginSettings = { fields: [{ name: "note", type: "string", default: null }], values: {} }
    expect(initialDraft(settings)).toEqual({ note: "" })
    expect(settingsChanges(settings, { note: "" })).toEqual({})
  })

  it("doesn't refuse an enum field that has no default and was never set", () => {
    const settings: PluginSettings = { fields: [{ name: "mode", type: "string", enum: ["a", "b"] }, { name: "on", type: "boolean" }], values: {} }
    const draft = { ...initialDraft(settings), on: true }
    expect(draftProblems(settings, draft)).toEqual({})
    expect(settingsChanges(settings, draft)).toEqual({ on: true })
  })

  it("sends only what changed", () => {
    const draft = initialDraft(SETTINGS)
    expect(settingsChanges(SETTINGS, draft)).toEqual({})
    const edited: SettingsDraft = { ...draft, frequency: "weekly", per_post: "", skip_own: false, title: "Links" }
    // A cleared number goes back to its default (null); an unchanged field isn't sent.
    expect(settingsChanges(SETTINGS, edited)).toEqual({ frequency: "weekly", per_post: null, skip_own: false })
    expect(settingsChanges(SETTINGS, { ...draft, ratio: "0.5" })).toEqual({ ratio: 0.5 })
  })

  it("keeps a saved secret unless a new one is typed", () => {
    const draft = initialDraft(SETTINGS)
    expect(settingsChanges(SETTINGS, { ...draft, api_key: { set: true, replacing: true, value: "" } })).toEqual({})
    expect(settingsChanges(SETTINGS, { ...draft, api_key: { set: true, replacing: true, value: "new" } })).toEqual({ api_key: "new" })
    // Typed, then "Keep the saved one".
    expect(settingsChanges(SETTINGS, { ...draft, api_key: { set: true, replacing: false, value: "new" } })).toEqual({})
    const unset = { ...SETTINGS, values: {} as PluginSettings["values"] }
    expect(settingsChanges(unset, { ...initialDraft(unset), api_key: { set: false, replacing: false, value: "k" } })).toEqual({ api_key: "k" })
  })

  it("checks each value as the API does, in the form's words", () => {
    const [secret, frequency, perPost, ratio, , title] = SETTINGS.fields
    // The canvas's wording for a range; "whole" only for a fraction.
    expect(fieldProblem(perPost, "500")).toBe("Enter a number from 1 to 200.")
    expect(fieldProblem(perPost, "1.5")).toBe("Enter a whole number from 1 to 200.")
    expect(fieldProblem(perPost, "ten")).toBe("Enter a number.")
    expect(fieldProblem(perPost, "")).toBeNull()
    expect(fieldProblem(perPost, "200")).toBeNull()
    expect(fieldProblem(ratio, "-1")).toBe("Enter a number of at least 0.")
    expect(fieldProblem(title, "too long")).toBe("Use at most 5 characters.")
    expect(fieldProblem(frequency, "hourly")).toBe("Choose one of the options.")
    expect(fieldProblem(secret, { set: false, replacing: false, value: "123456789" })).toBe("Use at most 8 characters.")
    expect(fieldProblem(secret, { set: true, replacing: false, value: "123456789" })).toBeNull()
    expect(draftProblems(SETTINGS, { ...initialDraft(SETTINGS), per_post: "0", title: "toolong" })).toEqual({
      per_post: "Enter a number from 1 to 200.",
      title: "Use at most 5 characters.",
    })
  })

  it("labels enum options readably", () => {
    expect(optionLabel("daily")).toBe("Daily")
    expect(optionLabel("on_publish")).toBe("On publish")
    expect(optionLabel(30)).toBe("30")
  })
})
