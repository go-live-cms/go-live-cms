import type { SiteDesignOverview, SiteDesignProblem, SiteTemplate, SiteTemplateKind } from "./api/siteDesign"

// The Site editor's rules (#493, docs/design/theme-builder.md 8, 9, 13; the redesign canvas's
// row 8 "Site editor" boards): what renders each kind of page now, the rows of the overview
// and their menus, the names of new templates and parts, what a publish lists and refuses.
// Pure: the pages read the API and call these.

// ── Names ───────────────────────────────────────────────────────────────────────────────

/** A builder page template's slug prefix (design 10): `custom-<name>`, stored by pages as `block:<name>`. */
export const CUSTOM_TEMPLATE_PREFIX = "custom-"
/** The longest saved name (design 13.1): `block:[a-z0-9-]{1,64}`. */
export const TEMPLATE_NAME_MAX = 64

/**
 * A typed name as it is saved (design 13.1, "Names of new templates and parts"): Latin accents
 * dropped (as `headingAnchors` does), lower case, each run of anything but `a-z0-9` one hyphen,
 * hyphens trimmed from both ends, cut to 64 characters, then trimmed again. "" when nothing is
 * left. It fits `block:[a-z0-9-]{1,64}` and, prefixed, the slug CHECK.
 */
export function savedTemplateName(typed: string): string {
  const full = slugPart(typed)
  return full.slice(0, TEMPLATE_NAME_MAX).replace(/-+$/, "")
}

function slugPart(typed: string): string {
  return typed
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export type NewNameCheck =
  | { ok: true; name: string; slug: string }
  | { ok: false; name: string; slug: string | null; error: string | null }

/**
 * The New template / New part dialog's check, as it is typed: the saved name and slug, or why
 * it can't be used. An empty field is not an error yet (`error: null`); the button stays off.
 * `taken` holds the slugs of that kind the theme already has.
 */
export function checkNewName(typed: string, kind: SiteTemplateKind, taken: ReadonlySet<string>, themeName: string): NewNameCheck {
  if (!typed.trim()) return { ok: false, name: "", slug: null, error: null }
  const full = slugPart(typed)
  if (!full) return { ok: false, name: "", slug: null, error: "Use at least one letter or number." }
  if (full.length > TEMPLATE_NAME_MAX) {
    return { ok: false, name: savedTemplateName(typed), slug: null, error: `Use a shorter name: it can be up to ${TEMPLATE_NAME_MAX} characters.` }
  }
  const slug = kind === "template" ? `${CUSTOM_TEMPLATE_PREFIX}${full}` : full
  if (taken.has(slug)) {
    const what = kind === "template" ? "page template" : "part"
    return { ok: false, name: full, slug, error: `There’s already a ${what} called ${humanize(full)} in ${themeName}.` }
  }
  return { ok: true, name: full, slug }
}

/** "full-width" → "Full width", "promo_bar" → "Promo bar". */
export function humanize(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// ── What each slug is ───────────────────────────────────────────────────────────────────

/** The overview's groups of templates, in the board's order. */
export const ROUTE_GROUPS = [
  { id: "home", label: "Home and front page" },
  { id: "posts", label: "Posts" },
  { id: "pages", label: "Pages" },
  { id: "archives", label: "Archives" },
  { id: "search", label: "Search and errors" },
] as const
export type RouteGroupId = (typeof ROUTE_GROUPS)[number]["id"]

/** Labels the overview knows for the site's types, page layouts and taxonomies. */
export interface SiteVocabulary {
  /** Post types besides `post` and `page`, by name. */
  postTypes?: ReadonlyArray<{ name: string; label: string }>
  /** The theme's page layouts besides `default` (#336). */
  pageLayouts?: ReadonlyArray<{ name: string; label: string }>
  /** Public taxonomies, by name. */
  taxonomies?: ReadonlyArray<{ name: string; label: string }>
}

const labelIn = (list: SiteVocabulary[keyof SiteVocabulary], name: string) => list?.find((item) => item.name === name)?.label

/** Which group a template slug belongs to (unknown slugs go with pages). */
export function routeGroupOf(slug: string): RouteGroupId {
  if (slug === "front-page" || slug === "home") return "home"
  if (slug === "single" || slug.startsWith("single-")) return "posts"
  if (slug === "archive" || slug.startsWith("archive-") || slug.startsWith("taxonomy-") || slug === "author") return "archives"
  if (slug === "search" || slug === "404") return "search"
  return "pages"
}

/** A template or part's name in the Site editor: the board's "Single post", "Page · Full width", "Category". */
export function siteTemplateName(kind: SiteTemplateKind, slug: string, vocabulary: SiteVocabulary = {}, title?: string): string {
  if (kind === "part") return title?.trim() || humanize(slug)
  if (slug.startsWith(CUSTOM_TEMPLATE_PREFIX)) return title?.trim() || humanize(slug.slice(CUSTOM_TEMPLATE_PREFIX.length))
  const fixed: Record<string, string> = {
    "front-page": "Front page",
    home: "Home",
    single: "Single post",
    page: "Page",
    archive: "Archive",
    author: "Author",
    search: "Search",
    "404": "404",
  }
  if (fixed[slug]) return fixed[slug]
  const rest = (prefix: string) => slug.slice(prefix.length)
  if (slug.startsWith("single-")) return `Single · ${labelIn(vocabulary.postTypes, rest("single-")) ?? humanize(rest("single-"))}`
  if (slug.startsWith("archive-")) return `Archive · ${labelIn(vocabulary.postTypes, rest("archive-")) ?? humanize(rest("archive-"))}`
  if (slug.startsWith("page-")) return `Page · ${labelIn(vocabulary.pageLayouts, rest("page-")) ?? humanize(rest("page-"))}`
  if (slug.startsWith("taxonomy-")) {
    const name = rest("taxonomy-")
    // The core taxonomies by their singular names (the board's "Category"); others by their label.
    if (name === "category") return "Category"
    if (name === "post_tag" || name === "tag") return "Tag"
    return labelIn(vocabulary.taxonomies, name) ?? humanize(name)
  }
  return title?.trim() || humanize(slug)
}

/**
 * Whether a template's route has a list of its own (13.1), so a query loop there may use
 * "This page's list": home, the front page (latest posts), archives, taxonomies, author and search.
 */
export function routeHasList(kind: SiteTemplateKind, slug: string): boolean {
  if (kind === "part") return false
  return (
    slug === "home" ||
    slug === "front-page" ||
    slug === "archive" ||
    slug.startsWith("archive-") ||
    slug.startsWith("taxonomy-") ||
    slug === "author" ||
    slug === "search"
  )
}

/**
 * The theme's code layout that renders a slug while nothing overrides it (the folders
 * `templateRanks` names, `src/lib/siteTemplates.ts`): "post/default", "page/fullwidth", "term".
 * Null for a slug no code layout renders (`front-page`, a builder page template).
 */
export function codeLayoutOf(slug: string): string | null {
  if (slug === "home") return "home/default"
  if (slug === "single" || slug.startsWith("single-")) return "post/default"
  if (slug === "page") return "page/default"
  if (slug.startsWith("page-")) return `page/${slug.slice("page-".length)}`
  if (slug === "archive" || slug.startsWith("archive-")) return "archive/default"
  if (slug.startsWith("taxonomy-")) return "term/default"
  if (slug === "author") return "author/default"
  if (slug === "search") return "search/default"
  if (slug === "404") return "error/default"
  return null
}

/** The slug a less specific route falls back to when it has no template (3.2), for "Uses Single post". */
function fallbackSlug(slug: string): string | null {
  if (slug.startsWith("single-")) return "single"
  if (slug.startsWith("archive-")) return "archive"
  return null
}

// ── The overview (13.1 "Overview vocabulary") ───────────────────────────────────────────

export type PillTone = "accent" | "success" | "warning" | "neutral"

export interface OverviewRow {
  kind: SiteTemplateKind
  slug: string
  name: string
  /** "Page template" on a builder page template. */
  tag: string | null
  /** The customized row, or null when the theme's own renders it. */
  row: SiteTemplate | null
  pill: { label: string; tone: PillTone } | null
  /** What renders it when it isn't customized ("Theme layout · post/default"). */
  source: string | null
  /** A second line ("Replaces Paper's post layouts, …"). */
  meta: string | null
  /** The row's button: Edit a customized one, else Customize. */
  action: "Edit" | "Customize"
  /** Where Customize starts the working copy (POST /site-design/templates `from`). */
  customizeFrom: "theme" | "starter" | "blank"
}

export interface OverviewInput {
  themeName: string
  overview: Pick<SiteDesignOverview, "templates">
  /** The theme's shipped block templates and parts (5.7: `config.block_templates` / `block_parts`), by slug. */
  shippedTemplates?: Readonly<Record<string, unknown>>
  shippedParts?: Readonly<Record<string, unknown>>
  vocabulary?: SiteVocabulary
}

/** Core's starters (#491, `sitedesign.Starter`): every template slug has one, parts only these. */
export const STARTER_PARTS = ["header", "footer"] as const

/** The state pill of a customized row (8.1, 9, 13.1), or null for one that is simply live. */
export function rowPill(row: SiteTemplate): { label: string; tone: PillTone } | null {
  if (row.change === "reset") return { label: "Resets on publish", tone: "warning" }
  if (row.default_changed) return { label: "Default changed since you customized", tone: "warning" }
  if (row.has_unpublished_changes) return { label: "Customized · changes not published", tone: "accent" }
  if (row.working_state === "reset") return null
  return { label: "Customized", tone: "success" }
}

/** What renders `slug` while nothing customized does: the theme's block template, a fallback template, or its code layout. */
function themeSource(input: OverviewInput, kind: SiteTemplateKind, slug: string, published: Map<string, SiteTemplate>): string {
  const theme = input.themeName
  if (kind === "part") {
    if (input.shippedParts && slug in input.shippedParts) return `Theme part · ${theme}’s ${slug}`
    if ((STARTER_PARTS as readonly string[]).includes(slug)) return `Theme layout · ${theme}’s ${slug}`
    return "Not in any layout yet"
  }
  if (input.shippedTemplates && slug in input.shippedTemplates) return `Theme template · ${slug}`
  const fallback = fallbackSlug(slug)
  if (fallback && published.has(fallback)) return `Uses ${siteTemplateName("template", fallback, input.vocabulary)}`
  if (slug === "front-page") return "Not customized · Home renders /"
  const layout = codeLayoutOf(slug)
  return layout ? `Theme layout · ${layout}` : "Not customized"
}

function rowMeta(input: OverviewInput, row: SiteTemplate | null, kind: SiteTemplateKind, slug: string): string | null {
  const theme = input.themeName
  if (row?.default_changed) return `${theme} changed its default since you customized it. Start over from the menu to take it; nothing changes on its own.`
  if (!row || row.working_state === "reset" || kind === "part") return null
  // 13.1: a customized `single` replaces the type's layout choice; `archive` leaves term pages.
  if (slug === "single") return `Replaces ${theme}’s post layouts, so a post type’s layout choice no longer applies to posts.`
  if (slug === "archive") return `Category and tag pages still use ${theme}’s term layout. Customize Category to change them.`
  return null
}

function customizeFrom(input: OverviewInput, kind: SiteTemplateKind, slug: string): OverviewRow["customizeFrom"] {
  const shipped = kind === "part" ? input.shippedParts : input.shippedTemplates
  if (shipped && slug in shipped) return "theme"
  if (kind === "template" || (STARTER_PARTS as readonly string[]).includes(slug)) return "starter"
  return "blank"
}

function overviewRow(input: OverviewInput, kind: SiteTemplateKind, slug: string, row: SiteTemplate | null, published: Map<string, SiteTemplate>): OverviewRow {
  const pill = row ? rowPill(row) : null
  // A reset row (or one whose reset was published) renders the theme's again: say what does.
  const showsTheme = !row || row.working_state === "reset"
  return {
    kind,
    slug,
    name: siteTemplateName(kind, slug, input.vocabulary, row?.title),
    tag: kind === "template" && slug.startsWith(CUSTOM_TEMPLATE_PREFIX) ? "Page template" : null,
    row,
    pill,
    source: showsTheme ? themeSource(input, kind, slug, published) : null,
    meta: rowMeta(input, row, kind, slug),
    action: row ? "Edit" : "Customize",
    customizeFrom: customizeFrom(input, kind, slug),
  }
}

/** The template slugs the overview always lists (the routes a site has), customized or not. */
export function routeSlugs(input: OverviewInput): string[] {
  const v = input.vocabulary ?? {}
  return [
    "front-page",
    "home",
    "single",
    ...(v.postTypes ?? []).map((t) => `single-${t.name}`),
    "page",
    ...(v.pageLayouts ?? []).filter((l) => l.name !== "default").map((l) => `page-${l.name}`),
    "archive",
    ...(v.taxonomies ?? []).map((t) => `taxonomy-${t.name}`),
    "author",
    "search",
    "404",
  ]
}

/** The overview's Templates list: groups in the board's order, rows in route order, then the custom ones. */
export function templateGroups(input: OverviewInput): Array<{ id: RouteGroupId; label: string; rows: OverviewRow[] }> {
  const rows = input.overview.templates.filter((t) => t.kind === "template")
  const bySlug = new Map(rows.map((t) => [t.slug, t]))
  const published = new Map(rows.filter((t) => t.published).map((t) => [t.slug, t]))
  const slugs = routeSlugs(input)
  for (const slug of input.shippedTemplates ? Object.keys(input.shippedTemplates).sort() : []) if (!slugs.includes(slug)) slugs.push(slug)
  const extra = rows
    .map((t) => t.slug)
    .filter((slug) => !slugs.includes(slug))
    .sort((a, b) => Number(a.startsWith(CUSTOM_TEMPLATE_PREFIX)) - Number(b.startsWith(CUSTOM_TEMPLATE_PREFIX)) || a.localeCompare(b))
  const all = [...slugs, ...extra].map((slug) => overviewRow(input, "template", slug, bySlug.get(slug) ?? null, published))
  return ROUTE_GROUPS.map(({ id, label }) => ({ id, label, rows: all.filter((r) => routeGroupOf(r.slug) === id) })).filter((g) => g.rows.length > 0)
}

/** The overview's Template parts: the starters and the theme's, then any other customized part. */
export function partRows(input: OverviewInput): OverviewRow[] {
  const rows = input.overview.templates.filter((t) => t.kind === "part")
  const bySlug = new Map(rows.map((t) => [t.slug, t]))
  const slugs: string[] = [...STARTER_PARTS]
  for (const slug of input.shippedParts ? Object.keys(input.shippedParts).sort() : []) if (!slugs.includes(slug)) slugs.push(slug)
  for (const slug of rows.map((t) => t.slug).sort()) if (!slugs.includes(slug)) slugs.push(slug)
  return slugs.map((slug) => overviewRow(input, "part", slug, bySlug.get(slug) ?? null, new Map()))
}

// ── Row menus (13.1) ────────────────────────────────────────────────────────────────────

export type RowActionId = "edit" | "preview" | "history" | "discard" | "start-over" | "reset" | "keep-editing" | "delete"

export interface RowAction {
  id: RowActionId
  label: string
  disabled?: boolean
  /** Why it's off, shown under the label. */
  hint?: string
  danger?: boolean
}

/**
 * A row's menu (the board's "Row menus"): Edit, Preview, History, Discard changes, Reset to
 * theme default, and Delete only for an item never published (section 9). A reset waiting for
 * publish offers Keep editing instead of Reset.
 */
export function rowActions(row: SiteTemplate | null): RowAction[] {
  if (!row) return [{ id: "preview", label: "Preview" }]
  const everPublished = row.published_version_no != null
  const actions: RowAction[] = [
    { id: "edit", label: "Edit" },
    { id: "preview", label: "Preview" },
    everPublished ? { id: "history", label: "History" } : { id: "history", label: "History", disabled: true, hint: "Nothing published yet" },
  ]
  if (everPublished && row.has_unpublished_changes) actions.push({ id: "discard", label: "Discard changes…" })
  if (row.working_state === "reset") actions.push({ id: "keep-editing", label: "Keep editing" })
  else if (row.published) actions.push({ id: "reset", label: "Reset to theme default…" })
  actions.push(
    row.can_delete
      ? { id: "delete", label: "Delete…", danger: true }
      : { id: "delete", label: "Delete", disabled: true, hint: "Published once. Reset it instead." }
  )
  return actions
}

// ── The editor's state ──────────────────────────────────────────────────────────────────

/** The editor's More menu (13.1): History, Discard changes, Start over from the theme default, Reset (or Keep editing), Delete. */
export function editorActions(row: SiteTemplate): RowAction[] {
  const actions: RowAction[] = [{ id: "history", label: "History", disabled: row.published_version_no == null, hint: row.published_version_no == null ? "Nothing published yet" : undefined }]
  if (row.published_version_no != null && row.has_unpublished_changes) actions.push({ id: "discard", label: "Discard changes…" })
  if (row.working_state === "custom") actions.push({ id: "start-over", label: "Start over from the theme default…" })
  if (row.working_state === "reset") actions.push({ id: "keep-editing", label: "Keep editing" })
  else if (row.published) actions.push({ id: "reset", label: "Reset to theme default…" })
  if (row.can_delete) actions.push({ id: "delete", label: "Delete…", danger: true })
  return actions
}

/** The top bar's pill for an open template or part. */
export function editorPill(row: SiteTemplate): { label: string; tone: PillTone } {
  return rowPill(row) ?? { label: "Theme default renders it", tone: "neutral" }
}

/** "Reset to theme default" (section 9's words): what renders after the publish. */
export function resetConsequence(kind: SiteTemplateKind, slug: string, name: string, themeName: string, shipped: boolean): string {
  if (kind === "part") return `${name} will use ${themeName}’s ${shipped ? "part" : "layout"} again when you publish. Your version stays in History, so you can restore it.`
  const layout = codeLayoutOf(slug)
  const what = shipped ? `${themeName}’s ${name} template` : layout ? `${themeName}’s code layout` : `${themeName}’s default`
  return `${name} will use ${what} again when you publish. Your version stays in History, so you can restore it.`
}

// ── Publish (8.2, 13.1 "Publish dialog") ────────────────────────────────────────────────

export interface PublishChange {
  key: string
  /** The item to open, or null for the global styles. */
  id: number | null
  kind: SiteTemplateKind | "styles"
  name: string
  what: string
}

/** Everything the next publish puts live, templates first, then parts, then the styles. */
export function publishChanges(
  overview: Pick<SiteDesignOverview, "templates" | "global_styles_changed" | "global_styles_groups">,
  vocabulary: SiteVocabulary = {},
  stylesLabel?: string
): PublishChange[] {
  const items = overview.templates
    .filter((t) => t.change)
    .sort((a, b) => Number(a.kind === "part") - Number(b.kind === "part") || a.slug.localeCompare(b.slug))
    .map<PublishChange>((t) => {
      const kindName = t.kind === "part" ? "Template part" : "Template"
      const what =
        t.change === "reset" ? `${kindName} · resets to the theme default` : t.published_version_no == null ? `${kindName} · new` : `${kindName} · changed`
      return { key: `t${t.id}`, id: t.id, kind: t.kind, name: siteTemplateName(t.kind, t.slug, vocabulary, t.title), what }
    })
  if (overview.global_styles_changed) {
    items.push({ key: "styles", id: null, kind: "styles", name: "Global styles", what: stylesLabel ?? groupsLabel(overview.global_styles_groups) })
  }
  return items
}

const STYLE_GROUP_LABELS: Record<string, string> = {
  colors: "Colours",
  fonts: "Fonts",
  type: "Type scale",
  typeScale: "Type scale",
  layout: "Layout",
  spacing: "Spacing",
  radius: "Radius",
}

/** ["colors", "fonts"] → "Colours, Fonts". */
export function groupsLabel(groups: readonly string[] | null | undefined): string {
  if (!groups?.length) return "Changed"
  return groups.map((g) => STYLE_GROUP_LABELS[g] ?? humanize(g)).join(", ")
}

export interface ProblemText {
  key: string
  title: string
  body: string
  /** The template or part to open to fix it. */
  openId: number | null
  openLabel: string
}

/** A refusal named (13.1: "Refusals come first and alone … each with Open"). */
export function problemText(problem: SiteDesignProblem, templates: readonly SiteTemplate[], vocabulary: SiteVocabulary = {}): ProblemText {
  const row = templates.find((t) => (problem.id != null ? t.id === problem.id : t.kind === problem.kind && t.slug === problem.slug))
  const name = siteTemplateName(problem.kind, problem.slug, vocabulary, row?.title)
  const openId = row?.id ?? problem.id ?? null
  const key = `${problem.code}:${problem.kind}:${problem.slug}:${problem.part ?? ""}`
  switch (problem.code) {
    case "template_empty":
      return {
        key,
        title: `${name} is empty`,
        body: "Every page it renders would be blank. Add blocks, or discard its changes.",
        openId,
        openLabel: `Open ${name}`,
      }
    case "part_unresolved":
      return {
        key,
        title: `${name} uses a part that doesn’t exist`,
        body: `Its template part block names “${problem.part ?? ""}”. Pick another part in the block, remove it, or create a part with that name.`,
        openId,
        openLabel: `Open ${name}`,
      }
    default:
      return {
        key,
        title: `${name} can’t be published`,
        body: problem.reason ? `${problem.reason}.`.replace(/\.\.$/, ".") : "It has blocks this site can’t show any more. Open it to see which.",
        openId,
        openLabel: `Open ${name}`,
      }
  }
}

/** The Publish button's accessible name ("Publish site design, 3 changes"). */
export function publishButtonLabel(count: number): string {
  return `Publish site design, ${count} ${count === 1 ? "change" : "changes"}`
}

// ── Preview (8.3) ───────────────────────────────────────────────────────────────────────

/**
 * The page a template's preview shows first, without reading content: a list route's own
 * address, or null for a route that needs a post or page (the picker chooses one).
 */
export function previewPathFor(kind: SiteTemplateKind, slug: string, terms: { taxonomy: string; slug: string } | null = null): string | null {
  if (kind === "part") return "/"
  if (slug === "home" || slug === "front-page") return "/"
  if (slug === "search") return "/search?q=the"
  if (slug === "404") return "/gl-preview-page-not-found"
  if (slug === "archive") return "/post"
  if (slug.startsWith("archive-")) return `/${encodeURIComponent(slug.slice("archive-".length))}`
  if (slug.startsWith("taxonomy-") && terms) return `/${encodeURIComponent(terms.taxonomy)}/${encodeURIComponent(terms.slug)}`
  return null
}

/** The post type whose posts a template's preview picks from (single, page and builder page templates). */
export function previewPostTypeFor(kind: SiteTemplateKind, slug: string): string | null {
  if (kind === "part") return null
  if (slug === "single") return "post"
  if (slug.startsWith("single-")) return slug.slice("single-".length)
  if (slug === "page" || slug.startsWith("page-") || slug.startsWith(CUSTOM_TEMPLATE_PREFIX)) return "page"
  return null
}

// ── Part usage (the part board's "Used in N templates") ─────────────────────────────────

export type DocLike = { blocks?: Record<string, { type?: string; attrs?: Record<string, unknown> } | undefined> } | null | undefined

/** The part slugs a template's doc places. */
export function partSlugsIn(doc: DocLike): string[] {
  const slugs = new Set<string>()
  for (const block of Object.values(doc?.blocks ?? {})) {
    if (block?.type === "template_part" && typeof block.attrs?.slug === "string") slugs.add(block.attrs.slug)
  }
  return [...slugs]
}

/** The templates (by name) whose doc places `part`, in name order. */
export function templatesUsingPart(part: string, docs: ReadonlyArray<{ name: string; doc: DocLike }>): string[] {
  return docs
    .filter((d) => partSlugsIn(d.doc).includes(part))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b))
}

/** "Used in 7 templates", "Not used in any template". */
export function usedInLabel(count: number): string {
  if (count === 0) return "Not used in any template"
  return `Used in ${count} ${count === 1 ? "template" : "templates"}`
}

// ── History (13 item 8) ─────────────────────────────────────────────────────────────────

/** A release's one line: "Header, Single post, Colours". */
export function releaseSummary(items: ReadonlyArray<{ kind: SiteTemplateKind; slug: string; title: string }>, styleGroups: readonly string[] | null, vocabulary: SiteVocabulary = {}): string {
  const names = items.map((i) => siteTemplateName(i.kind, i.slug, vocabulary, i.title))
  if (styleGroups && styleGroups.length) names.push(groupsLabel(styleGroups))
  return names.join(", ") || "Nothing listed"
}

/** A release's or version's time as the History board writes it: "Nov 14, 10:02" ("Nov 14, 2025, 10:02" in another year). */
export function releaseTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) })
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  return `${day}, ${time}`
}
