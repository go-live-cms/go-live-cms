// The Import page's rules and wording (#150, the canvas's "Posts · Import" board). Pure,
// so lib/imports.test.ts pins them; the page (pages/Import.tsx) only renders them.

import type {
  ImportItem,
  ImportJob,
  ImportListItem,
  ImportMapping,
  ImportMediaFailure,
  ImportStatus,
  ImportSummary,
} from "./api/imports"

export const IMPORT_ACCEPT = ".xml,.zip,application/xml,text/xml,application/zip"
export const IMPORT_HELP =
  "In WordPress: Tools › Export › All content. Markdown: a .zip of .md files with front matter (title, date, slug, tags, categories, description)."

// How often the page asks for a running import's progress.
export const IMPORT_POLL_MS = 1500

export const STATUS_LABELS: Record<ImportStatus, string> = {
  mapping: "Not started",
  queued: "Waiting to start",
  running: "Importing",
  done: "Finished",
  failed: "Failed",
  cancelled: "Stopped",
}

export const STATUS_TONES: Record<ImportStatus, "success" | "warning" | "info" | "danger" | "neutral"> = {
  mapping: "warning",
  queued: "info",
  running: "info",
  done: "success",
  failed: "danger",
  cancelled: "neutral",
}

export const isActive = (status: ImportStatus) => status === "queued" || status === "running"

export function sourceLabel(source: ImportSummary["source"]): string {
  return source === "markdown" ? "Markdown" : "WordPress"
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`
}

// "a, b and c"
export function listPhrase(parts: string[]): string {
  if (parts.length <= 1) return parts.join("")
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

// The GoLive post types an export type may map to, "" = Don't import.
export interface TypeChoice {
  value: string
  label: string
}

export const DONT_IMPORT: TypeChoice = { value: "", label: "Don’t import" }

export function typeChoices(postTypes: { name: string; label: string }[]): TypeChoice[] {
  return [...postTypes.map((t) => ({ value: t.name, label: t.label })), DONT_IMPORT]
}

// What an export's post type is called: core's by name, others "Products (product)".
export function exportTypeLabel(type: string): string {
  if (type === "post") return "Posts"
  if (type === "page") return "Pages"
  const words = type.replace(/[_-]+/g, " ").trim()
  const label = words.charAt(0).toUpperCase() + words.slice(1)
  const pluralLabel = /s$/.test(label) ? label : /[^aeiou]y$/.test(label) ? `${label.slice(0, -1)}ies` : `${label}s`
  return `${pluralLabel} (${type})`
}

export interface MemberChoice {
  value: string
  label: string
}

export const IMPORTER_CHOICE = (selfName: string): MemberChoice => ({ value: "0", label: `You (${selfName}, the importer)` })

// The mapping the page starts from: each author to their suggested member (or you), each
// type to its suggestion.
export function defaultMapping(summary: ImportSummary): ImportMapping {
  return {
    authors: Object.fromEntries(summary.authors.map((a) => [a.login, a.suggested_user_id || 0])),
    types: Object.fromEntries(summary.types.map((t) => [t.type, t.suggested])),
  }
}

export function authorMeta(author: ImportSummary["authors"][number]): string {
  const parts = [author.login, plural(author.posts, "post")]
  if (author.matched_by === "email") parts.push("same email as a member")
  if (author.matched_by === "username") parts.push("same user name as a member")
  return parts.join(" · ")
}

export function typeMeta(t: ImportSummary["types"][number]): string {
  return `${t.count.toLocaleString("en-US")} in the export${t.published > 0 ? `, ${t.published.toLocaleString("en-US")} published` : ""}`
}

// What will be imported with the mapping as chosen: the line under the choices.
export function previewSentence(summary: ImportSummary, mapping: ImportMapping, postTypeLabels: Record<string, string>): string {
  const byTarget = new Map<string, number>()
  for (const t of summary.types) {
    const target = mapping.types[t.type] ?? ""
    if (!target) continue
    byTarget.set(target, (byTarget.get(target) ?? 0) + t.count)
  }
  const parts = [...byTarget.entries()].map(([target, n]) => {
    const label = (postTypeLabels[target] ?? target).toLowerCase()
    return plural(n, label.endsWith("s") ? label.slice(0, -1) : label, label)
  })
  if (summary.categories > 0) parts.push(plural(summary.categories, "category", "categories"))
  if (summary.tags > 0) parts.push(plural(summary.tags, "tag"))
  if (parts.length === 0) return "Nothing: choose at least one content type to import."
  const media =
    summary.source === "markdown"
      ? summary.files > 0
        ? " and the images in the zip they use"
        : ""
      : summary.site_host
        ? ` and the images they use from ${summary.site_host}`
        : ""
  return `${listPhrase(parts)}${media}.`
}

export function importCount(summary: ImportSummary, mapping: ImportMapping): number {
  return summary.types.reduce((n, t) => n + (mapping.types[t.type] ? t.count : 0), 0)
}

const NOT_IMPORTED_LABELS: Record<string, [string, string]> = {
  comments: ["comment", "comments"],
  nav_menu_item: ["menu item", "menu items"],
  revision: ["revision", "revisions"],
  wp_template: ["template", "templates"],
  wp_template_part: ["template part", "template parts"],
  wp_navigation: ["navigation menu", "navigation menus"],
  wp_global_styles: ["global styles entry", "global styles entries"],
  other_files: ["other file", "other files"],
  large_files: ["file over the upload limit", "files over the upload limit"],
}

// "3 posts were imported before and will be skipped. Not imported: 18 products, 120
// comments." (null when there's nothing to say).
export function skippedSentence(summary: ImportSummary, mapping: ImportMapping, importedBefore: number): string | null {
  const sentences: string[] = []
  if (importedBefore > 0) {
    sentences.push(`${plural(importedBefore, "item")} ${importedBefore === 1 ? "was" : "were"} imported before and will be skipped.`)
  }
  const parts: string[] = []
  for (const t of summary.types) {
    if (mapping.types[t.type] ?? "") continue
    const many = exportTypeLabel(t.type).replace(/ \(.*\)$/, "").toLowerCase()
    const one = many.endsWith("ies") ? `${many.slice(0, -3)}y` : many.replace(/s$/, "")
    parts.push(plural(t.count, one, many))
  }
  const trash = summary.skipped?.in_trash ?? 0
  if (trash > 0) parts.push(`${plural(trash, "item")} in the trash`)
  for (const [key, n] of Object.entries(summary.not_imported ?? {})) {
    if (!n) continue
    const [one, many] = NOT_IMPORTED_LABELS[key] ?? [key.replace(/_/g, " "), key.replace(/_/g, " ")]
    parts.push(plural(n, one, many))
  }
  if (summary.other_terms > 0) parts.push(plural(summary.other_terms, "term of other taxonomies", "terms of other taxonomies"))
  if (parts.length > 0) sentences.push(`Not imported: ${listPhrase(parts)}.`)
  return sentences.length > 0 ? sentences.join(" ") : null
}

export function progressLine(job: Pick<ImportJob, "progress">): string {
  const p = job.progress
  const done = p.total - p.pending
  return `${done.toLocaleString("en-US")} of ${plural(p.total, "item")}`
}

export function progressDetail(job: Pick<ImportJob, "progress">): string {
  const p = job.progress
  const parts = [`${p.imported.toLocaleString("en-US")} imported`]
  if (p.skipped) parts.push(`${p.skipped.toLocaleString("en-US")} skipped`)
  if (p.failed) parts.push(`${p.failed.toLocaleString("en-US")} failed`)
  return parts.join(" · ")
}

export function progressPercent(job: Pick<ImportJob, "progress">): number {
  const p = job.progress
  if (p.total === 0) return 100
  return Math.round(((p.total - p.pending) / p.total) * 100)
}

// The report's summary line: "44 imported · 3 skipped · 1 failed · 2 with dropped blocks".
export function reportSummary(job: Pick<ImportJob, "progress">, mediaFailed = 0): string {
  const p = job.progress
  const parts = [`${p.imported.toLocaleString("en-US")} imported`]
  if (p.skipped) parts.push(`${p.skipped.toLocaleString("en-US")} skipped`)
  if (p.failed) parts.push(`${p.failed.toLocaleString("en-US")} failed`)
  if (p.pending) parts.push(`${p.pending.toLocaleString("en-US")} not imported`)
  if (p.with_dropped) parts.push(`${p.with_dropped.toLocaleString("en-US")} with dropped blocks`)
  if (mediaFailed) parts.push(`${plural(mediaFailed, "image")} failed`)
  return parts.join(" · ")
}

export function recentMeta(job: ImportListItem, now = new Date()): string {
  const date = new Date(job.created_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(new Date(job.created_at).getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  })
  switch (job.status) {
    case "mapping":
      return `${date} · waiting for the mapping`
    case "queued":
    case "running":
      return `${date} · ${progressLine(job)}`
    case "cancelled":
      return `${date} · ${job.progress.total - job.progress.pending} of ${job.progress.total} when stopped`
    default:
      return `${date} · ${reportSummary(job)}`
  }
}

// Skipped and failed items' reasons (import_items.reason, api/import_worker.go).
export const REASONS: Record<string, string> = {
  imported_before: "Imported before",
  type_not_imported: "Its type isn’t imported",
  in_trash: "In the WordPress trash",
  auto_draft: "An unsaved draft",
  invalid_body: "The body couldn’t be stored",
  save_failed: "The post couldn’t be saved",
  unreadable: "The item couldn’t be read",
}

export function reasonText(item: Pick<ImportItem, "reason" | "result">): string {
  const base = (item.reason && REASONS[item.reason]) || "Not imported"
  return item.result?.error ? `${base}: ${item.result.error}` : base
}

// The notes an item's report may carry (import_items.result.notes).
export const NOTES: Record<string, string> = {
  extra_categories: "A post has one category here: the first one was kept",
  embeds_as_links: "Embeds from sites GoLive doesn’t embed became links",
  converted_blocks: "Some plugin blocks were brought over as their saved content",
  page_breaks: "Page breaks were removed",
  cover_video: "A cover with a video background became its content",
  media_text_video: "A media & text block with a video became its content",
  publish_unchecked: "Imported as a draft: the publishing checks couldn’t run",
  was_private: "Private in WordPress: imported as a draft",
  was_future: "Scheduled in WordPress: imported as a draft",
  was_pending: "Pending review in WordPress: imported as a draft",
}

export function noteTexts(item: Pick<ImportItem, "result">): string[] {
  const notes = (item.result?.notes ?? []).map((n) => NOTES[n] ?? n)
  if (item.result?.publish_refused) notes.push(`Imported as a draft: ${item.result.publish_refused}`)
  if (item.result?.slug) notes.push(`Its address was taken, so it is /${item.result.slug}`)
  if (item.result?.redirects?.length) {
    notes.push(`${item.result.redirects.length === 1 ? "The old address redirects" : "The old addresses redirect"} here: ${item.result.redirects.join(", ")}`)
  }
  return notes
}

// "Post · Published"
export function itemMeta(item: ImportItem): string {
  const type = item.post_type ? item.post_type.charAt(0).toUpperCase() + item.post_type.slice(1) : item.type
  if (item.status !== "imported") return `${type} · ${item.status === "skipped" ? "Skipped" : item.status === "failed" ? "Failed" : "Waiting"}`
  const status = item.post_status === "published" ? "Published" : item.post_status ? "Draft" : "Deleted since"
  return `${type} · ${status}`
}

// "2 blocks couldn’t be kept"
export function droppedTitle(n: number): string {
  return `${n} block${n === 1 ? "" : "s"} couldn’t be kept`
}

// "— after “Get in touch”", or "— at the start"
export function droppedWhere(after: string | undefined): string {
  return after ? `after “${after}”` : "at the start"
}

// The text "Copy the original as text" puts on the clipboard: each dropped block's
// original, separated by a blank line.
export function originalText(dropped: { label: string; original: string }[]): string {
  return dropped.map((d) => d.original).join("\n\n")
}

// The editor's notice for an imported post: its title and one line per left-out block or
// image ("Contact Form 7 shortcode — after “Get in touch”").
export function importNoticeTitle(notice: { dropped: unknown[]; media_failed: unknown[] }): string {
  const parts: string[] = []
  if (notice.dropped.length > 0) parts.push(droppedTitle(notice.dropped.length))
  if (notice.media_failed.length > 0) {
    parts.push(`${notice.media_failed.length} image${notice.media_failed.length === 1 ? "" : "s"} couldn’t be added`)
  }
  return `${parts.join(", and ")} in the import`
}

export function importNoticeBody(notice: { dropped: { label: string; after?: string }[]; media_failed: ImportMediaFailure[] }): string[] {
  return [
    ...notice.dropped.map((d) => `${d.label} — ${droppedWhere(d.after)}`),
    ...notice.media_failed.map((m) => `${m.url}: ${m.reason}`),
  ]
}

// Every image an import couldn't add, with the post it was in.
export function failedMedia(items: ImportItem[]): (ImportMediaFailure & { post: string })[] {
  return items.flatMap((item) => (item.result?.media_failed ?? []).map((f) => ({ ...f, post: item.title || "Untitled" })))
}

export type ReportTab = "all" | "imported" | "dropped" | "skipped" | "failed"

export function reportTabs(job: Pick<ImportJob, "progress">): { id: ReportTab; label: string; count: number }[] {
  const p = job.progress
  const tabs: { id: ReportTab; label: string; count: number }[] = [
    { id: "all", label: "All", count: p.total },
    { id: "imported", label: "Imported", count: p.imported },
    { id: "dropped", label: "With dropped blocks", count: p.with_dropped },
    { id: "skipped", label: "Skipped", count: p.skipped },
    { id: "failed", label: "Failed", count: p.failed },
  ]
  return tabs.filter((t) => t.id === "all" || t.count > 0)
}

export function tabQuery(tab: ReportTab): { status?: "imported" | "skipped" | "failed"; dropped?: boolean } {
  switch (tab) {
    case "imported":
      return { status: "imported" }
    case "dropped":
      return { dropped: true }
    case "skipped":
      return { status: "skipped" }
    case "failed":
      return { status: "failed" }
  }
  return {}
}

// The file errors the API answers (422 with the reader's code, 413), as shown.
export const FILE_ERRORS: Record<string, string> = {
  not_an_export: "This file isn’t a WordPress export or a zip of Markdown files",
  too_large: "The file is too large",
  no_file: "Choose a WordPress export (.xml) or a zip of Markdown files",
}

export function finishedTitle(status: ImportStatus): string {
  switch (status) {
    case "done":
      return "Import finished"
    case "cancelled":
      return "Import stopped"
    case "failed":
      return "Import failed"
  }
  return "Import"
}
