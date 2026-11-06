import type { PageTemplate } from "@gl-admin/lib/api/themes"
import type { SelectOption } from "@gl-admin/components/ui/Select"

// Page templates (#336): a page picks one of the active theme's page layouts. The list
// is the API's theme scan (`config.page_templates`: layouts/page/*.astro, named and
// described by theme.config.ts), which is also what PUT /posts/:id/template accepts. A
// page stores "" for the theme's default; a name the active theme doesn't have (after
// a theme switch) renders as the default and stays stored.

export const DEFAULT_TEMPLATE = "default"

// The API's rule for a name (api/page_templates.go pageTemplateNameRe).
const NAME = /^[A-Za-z0-9_-]{1,64}$/

const DEFAULT_ENTRY: PageTemplate = { name: DEFAULT_TEMPLATE, label: "Default" }

// The active theme's templates from its config, "default" first (and always there:
// every theme has layouts/page/default.astro).
export function pageTemplatesOf(config: unknown): PageTemplate[] {
  const raw = (config as { page_templates?: unknown } | null | undefined)?.page_templates
  const list = Array.isArray(raw) ? raw : []
  const seen = new Set<string>()
  const templates: PageTemplate[] = []
  for (const item of list) {
    const name = typeof item?.name === "string" ? item.name : ""
    if (!NAME.test(name) || seen.has(name)) continue
    seen.add(name)
    const label = typeof item.label === "string" && item.label.trim() ? item.label.trim() : humanize(name)
    const description = typeof item.description === "string" && item.description.trim() ? item.description.trim() : undefined
    templates.push(description ? { name, label, description } : { name, label })
  }
  const index = templates.findIndex((t) => t.name === DEFAULT_TEMPLATE)
  const defaultEntry = index >= 0 ? templates.splice(index, 1)[0] : DEFAULT_ENTRY
  return [defaultEntry, ...templates]
}

// "full-width" → "Full width", as the API labels an undeclared layout.
export function humanize(name: string): string {
  const words = name.replace(/[-_]+/g, " ").trim().toLowerCase()
  return words ? words[0].toUpperCase() + words.slice(1) : name
}

// The picker's value for a stored template: "" is the default.
export function templateValue(stored: string | null | undefined): string {
  return stored ? stored : DEFAULT_TEMPLATE
}

// What PUT /posts/:id/template gets for a picked value: "" for the default.
export function templateRequestValue(value: string): string {
  return value === DEFAULT_TEMPLATE ? "" : value
}

export interface TemplateDisplay {
  // What the page renders with, as the list and the picker name it.
  label: string
  description?: string
  // The stored template isn't in the active theme: the page uses the default.
  missing: boolean
}

// How a page's template reads (the Pages list's Template column). `templates` null:
// not loaded yet, so the stored name is shown as is.
export function describeTemplate(templates: PageTemplate[] | null, stored: string | null | undefined): TemplateDisplay {
  const name = templateValue(stored)
  if (!templates) return { label: name === DEFAULT_TEMPLATE ? DEFAULT_ENTRY.label : humanize(name), missing: false }
  const found = templates.find((t) => t.name === name)
  if (found) return { label: found.label, description: found.description, missing: false }
  const fallback = templates.find((t) => t.name === DEFAULT_TEMPLATE) ?? DEFAULT_ENTRY
  return { label: fallback.label, description: fallback.description, missing: true }
}

// "“landing” isn't in the active theme, so the page uses Default."
export function missingTemplateNote(stored: string, fallbackLabel: string): string {
  return `“${stored}” isn’t in the active theme, so the page uses ${fallbackLabel}.`
}

// The picker's options: the theme's templates; a stored one the theme doesn't have is
// listed too (marked), so the field shows what is saved until someone picks another.
export function templateOptions(templates: PageTemplate[], stored: string | null | undefined): SelectOption[] {
  const options: SelectOption[] = templates.map((t) => ({ value: t.name, label: t.label, description: t.description }))
  const name = templateValue(stored)
  if (!templates.some((t) => t.name === name)) {
    options.push({ value: name, label: `${humanize(name)} (not in this theme)`, description: "Renders with the default layout" })
  }
  return options
}
