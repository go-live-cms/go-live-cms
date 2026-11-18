import type { PageTemplate } from "@gl-admin/lib/api/themes"
import type { SelectOption } from "@gl-admin/components/ui/Select"

// Page templates (#336): a page picks one of the active theme's page layouts. The list
// is the API's theme scan (`config.page_templates`: layouts/page/*.astro, named and
// described by theme.config.ts), which is also what PUT /posts/:id/template accepts. A
// page stores "" for the theme's default; a name the active theme doesn't have (after
// a theme switch) renders as the default and stays stored.
//
// Builder page templates (#494, docs/design/theme-builder.md section 10): a page may also
// pick a page template made in the Site editor, one of the active theme's published
// `custom-<name>` templates, stored as `block:<name>`. The field lists them after the
// theme's layouts, under their own heading and tagged "Site editor" (the redesign
// canvas's "Template field with builder templates" board). A stored one that is no longer
// published (reset, deleted, or another theme's) is kept: the page renders with the
// default and picks it up again once it's published, as after a theme switch.
// GET /posts/page-templates lists both kinds (`pageTemplateChoicesOf`).

export const DEFAULT_TEMPLATE = "default"

// The API's rules for a name (api/page_templates.go pageTemplateNameRe and
// builderPageTemplateNameRe; 000062's CHECK).
const NAME = /^[A-Za-z0-9_-]{1,64}$/
const BUILDER_NAME = /^block:([a-z0-9-]{1,64})$/

const DEFAULT_ENTRY: PageTemplate = { name: DEFAULT_TEMPLATE, label: "Default" }

// The tag on a builder page template, in the list, on the field and in the Pages list.
export const SITE_EDITOR_TAG = "Site editor"
// The heading the builder page templates are listed under.
export const BUILDER_GROUP = "Made in the Site editor"

// What a page's Template field offers: the active theme's name (null when there's no
// active theme), its page layouts ("default" first) and its published Site editor page
// templates (`block:<name>`, by title).
export interface PageTemplateChoices {
  themeName: string | null
  templates: PageTemplate[]
  builder: PageTemplate[]
}

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

// GET /posts/page-templates's answer, read: anything malformed is left out.
export function pageTemplateChoicesOf(body: unknown): PageTemplateChoices {
  const data = (body && typeof body === "object" ? body : {}) as { theme?: unknown; templates?: unknown; builder_templates?: unknown }
  const theme = data.theme as { name?: unknown } | null | undefined
  const themeName = theme && typeof theme.name === "string" && theme.name.trim() ? theme.name.trim() : null
  const builder: PageTemplate[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(data.builder_templates) ? data.builder_templates : []) {
    const name = typeof item?.name === "string" ? item.name : ""
    const match = BUILDER_NAME.exec(name)
    if (!match || seen.has(name)) continue
    seen.add(name)
    const label = typeof item.label === "string" && item.label.trim() ? item.label.trim() : humanize(match[1])
    builder.push({ name, label })
  }
  return { themeName, templates: pageTemplatesOf({ page_templates: data.templates }), builder }
}

// Whether a stored or picked value is a Site editor page template (`block:<name>`).
export function isBuilderTemplate(name: string | null | undefined): boolean {
  return typeof name === "string" && BUILDER_NAME.test(name)
}

// "full-width" → "Full width", as the API labels an undeclared layout.
export function humanize(name: string): string {
  const words = name.replace(/[-_]+/g, " ").trim().toLowerCase()
  return words ? words[0].toUpperCase() + words.slice(1) : name
}

// A stored name as it reads without the list: `block:spring-launch` → "Spring launch".
function storedLabel(name: string): string {
  const builder = BUILDER_NAME.exec(name)
  return humanize(builder ? builder[1] : name)
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
  // The stored template isn't in the active theme (or, a builder one, isn't published
  // there): the page uses the default.
  missing: boolean
  // The stored template is a Site editor page template (`block:<name>`).
  builder: boolean
  // The stored template's own name: its title when listed, else from the stored name.
  storedLabel: string
}

// The heading the theme's layouts are listed under when builder templates follow them.
export function layoutsGroup(themeName: string | null): string {
  return themeName ? `${themeName}’s layouts` : "Theme layouts"
}

// How a page's template reads (the Pages list's Template column, the field's hint).
// `choices` null: not loaded yet, so the stored name is shown as is.
export function describeTemplate(choices: PageTemplateChoices | null, stored: string | null | undefined): TemplateDisplay {
  const name = templateValue(stored)
  const builder = isBuilderTemplate(name)
  const own = name === DEFAULT_TEMPLATE ? DEFAULT_ENTRY.label : storedLabel(name)
  if (!choices) return { label: own, missing: false, builder, storedLabel: own }
  const found = (builder ? choices.builder : choices.templates).find((t) => t.name === name)
  if (found) {
    const description = builder ? "A page template made in the Site editor." : found.description
    return { label: found.label, ...(description ? { description } : {}), missing: false, builder, storedLabel: found.label }
  }
  const fallback = choices.templates.find((t) => t.name === DEFAULT_TEMPLATE) ?? DEFAULT_ENTRY
  return { label: fallback.label, ...(fallback.description ? { description: fallback.description } : {}), missing: true, builder, storedLabel: own }
}

// "“landing” isn't in the active theme, so the page uses Default."
export function missingTemplateNote(stored: string, fallbackLabel: string): string {
  return `“${stored}” isn’t in the active theme, so the page uses ${fallbackLabel}.`
}

// "Pricing isn't published in Paper, so this page shows with Default. The choice is kept
// and applies again once it's published." (the board's wording)
export function unpublishedBuilderNote(label: string, themeName: string | null, fallbackLabel: string): string {
  return `${label} isn’t published in ${themeName ?? "the active theme"}, so this page shows with ${fallbackLabel}. The choice is kept and applies again once it’s published.`
}

// What the field and the Pages list say about a stored template the page can't use now,
// or undefined when it renders with it.
export function templateNote(choices: PageTemplateChoices | null, stored: string | null | undefined): string | undefined {
  const shown = describeTemplate(choices, stored)
  if (!shown.missing) return undefined
  return shown.builder ? unpublishedBuilderNote(shown.storedLabel, choices?.themeName ?? null, shown.label) : missingTemplateNote(templateValue(stored), shown.label)
}

// The picker's options: the theme's templates, then its published Site editor ones under
// their own heading (headings only when there are both kinds). A stored one the page
// can't use now is listed too (marked) in its kind's group, so the field shows what is
// saved until someone picks another.
export function templateOptions(choices: PageTemplateChoices, stored: string | null | undefined): SelectOption[] {
  const name = templateValue(stored)
  const storedBuilder = isBuilderTemplate(name)
  const grouped = choices.builder.length > 0 || storedBuilder
  const layouts = grouped ? { group: layoutsGroup(choices.themeName) } : {}
  const options: SelectOption[] = choices.templates.map((t) => ({ value: t.name, label: t.label, ...(t.description ? { description: t.description } : {}), ...layouts }))
  if (!storedBuilder && !choices.templates.some((t) => t.name === name)) {
    options.push({ value: name, label: `${humanize(name)} (not in this theme)`, description: "Renders with the default layout", ...layouts })
  }
  for (const t of choices.builder) options.push({ value: t.name, label: t.label, tag: SITE_EDITOR_TAG, group: BUILDER_GROUP })
  if (storedBuilder && !choices.builder.some((t) => t.name === name)) {
    options.push({ value: name, label: storedLabel(name), tag: SITE_EDITOR_TAG, group: BUILDER_GROUP, description: "Not published · renders with the default" })
  }
  return options
}
