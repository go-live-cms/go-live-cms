import { useEffect, useState } from "react"
import { getSettings, type Settings } from "@gl-admin/lib/api/settings"

// The workspace's editor settings (#330), read from GET /settings once per page load
// and refreshed when the Settings page saves.
//
// Markdown shortcuts are TipTap's input rules ("# " → heading, "- " → list, "> " → quote,
// "**x**" → bold…) and the matching paste rules. Turned off, only those rules go: the
// editor's options, never its extensions, schema or collaboration binding. An editor
// takes the value it mounts with; a change applies to editors opened after it.

export interface EditorSettings {
  markdownShortcuts: boolean
}

const DEFAULTS: EditorSettings = { markdownShortcuts: true }

// Rules that aren't Markdown and stay on either way: smart punctuation ("--" → "—",
// curly quotes) and linking a pasted URL.
const KEPT_INPUT_RULES = ["typography"]
const KEPT_PASTE_RULES = ["link"]

export function markdownRuleOptions(markdownShortcuts: boolean): {
  enableInputRules: true | string[]
  enablePasteRules: true | string[]
} {
  return markdownShortcuts
    ? { enableInputRules: true, enablePasteRules: true }
    : { enableInputRules: KEPT_INPUT_RULES, enablePasteRules: KEPT_PASTE_RULES }
}

export function toEditorSettings(settings: Pick<Settings, "editor_markdown_shortcuts"> | null | undefined): EditorSettings {
  return { markdownShortcuts: typeof settings?.editor_markdown_shortcuts === "boolean" ? settings.editor_markdown_shortcuts : DEFAULTS.markdownShortcuts }
}

let current: EditorSettings | null = null
let pending: Promise<EditorSettings> | null = null
const listeners = new Set<(settings: EditorSettings) => void>()

// Never rejects: a failed lookup gives the defaults (shortcuts on, as before #330) and
// is retried by the next editor that opens.
export function loadEditorSettings(): Promise<EditorSettings> {
  if (current) return Promise.resolve(current)
  pending ??= getSettings()
    .then((settings) => setEditorSettings(settings))
    .catch((error) => {
      console.warn("[Editor] Could not load the editor settings, using the defaults:", error)
      pending = null
      return DEFAULTS
    })
  return pending
}

// The Settings page calls this with what it saved.
export function setEditorSettings(settings: Pick<Settings, "editor_markdown_shortcuts">): EditorSettings {
  current = toEditorSettings(settings)
  pending = null
  listeners.forEach((listener) => listener(current!))
  return current
}

// null until loaded.
export function useEditorSettings(): EditorSettings | null {
  const [settings, setSettings] = useState<EditorSettings | null>(current)
  useEffect(() => {
    let cancelled = false
    listeners.add(setSettings)
    if (!current) loadEditorSettings().then((loaded) => !cancelled && setSettings((s) => s ?? loaded))
    return () => {
      cancelled = true
      listeners.delete(setSettings)
    }
  }, [])
  return settings
}

// Tests only.
export function resetEditorSettings() {
  current = null
  pending = null
  listeners.clear()
}
