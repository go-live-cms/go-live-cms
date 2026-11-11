import type { Editor } from "@tiptap/core"
import { installedThemeBlockEditors } from "@gl-admin/lib/theme-blocks/editorBlocks"
import { holderAcceptsType } from "../utils/blockTree"
import { createImagePlaceholder } from "./mediaBlocks"
import { openTableSizePicker } from "../ui/TableSizePicker"
import { COLUMNS_ICON, openColumnsPicker } from "../ui/ColumnsPicker"
import { TABLE_ICON } from "../extensions/TableBlock"
import { acceptsFootnoteRef } from "../extensions/FootnotesBlock"
import { EMBED_ICONS, MEDIA_BLOCK_ICONS, type EmbedProvider } from "@gl-admin/lib/blocks-spec"
import { requestEmbedFieldFocus, takeEmbedFieldFocus } from "./embedLinks"
import { requestHtmlFieldFocus, takeHtmlFieldFocus } from "./htmlSnippets"
import { currentAllowedEmbeds } from "@gl-admin/lib/editorSettings"

// The block catalog (#415, docs/design/block-library.md 3.1): every block the editor can
// insert, in one list. The slash menu, the + menu in the gutter, Turn into (turnInto.ts)
// and the block-type toolbar all read it. It holds the core blocks and every installed
// theme block; `menuEntries` decides which ones a menu offers (the role gate, the active
// theme, and the container slot's nesting table, #414: `slotAcceptsAt`).
//
// Adding a block = one entry in CORE_BLOCKS, in its group, in the order the menus show it.
// Only `id`, `type`, `name`, `group`, `icon` and `insert` are required:
//
//   {
//     id: "group",            // unique in the catalog; also Turn into's value
//     type: "group",          // the Block Spec type it creates
//     name: "Group",          // what the menus show, and what search matches
//     group: "layout",        // text | media | layout | embeds | advanced
//     keywords: ["container", "section"],
//     icon: { path: "M4 8V4h4…" },  // a 24×24 stroke path, or { glyph: "H1" }
//     insert: (editor, range) => editor.chain().focus().deleteRange(range).insertContent({ type: "group", … }).run(),
//   }
//
// `insert` replaces `range` (the typed "/query", or an empty range on the line + opened
// for) with the block and leaves the caret in it. It must be one ordinary command chain:
// no appendTransaction, no writes around the editor (rules 7 and 11 in
// lib/collaboration/CLAUDE.md).

export type BlockGroup = "text" | "media" | "layout" | "embeds" | "advanced"

/** The menus' groups, in the order the design shows them ("Inserting blocks"). */
export const BLOCK_GROUPS: readonly { id: BlockGroup; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "media", label: "Media" },
  { id: "layout", label: "Layout" },
  { id: "embeds", label: "Embeds" },
  { id: "advanced", label: "Advanced" },
]

export type CatalogRole = "admin" | "editor" | "contributor"

/** A 24×24 stroke icon (`path`, the design's icons) or a short text glyph ("H1"). */
export type BlockIconSpec = { path: string; glyph?: never } | { glyph: string; path?: never }

export interface InsertRange {
  from: number
  to: number
}

export interface CatalogEntry {
  /** Unique in the catalog. Turn into's value; for core blocks the old TurnIntoValue ids. */
  id: string
  /** The Block Spec type it inserts ("heading", "theme:example/alert"). */
  type: string
  name: string
  group: BlockGroup
  /** More words search matches (by prefix), shown beside a result found through one. */
  keywords?: readonly string[]
  /** The Markdown shortcut that also makes it, shown on the right ("##"). Must be a real input rule (catalog.markdown.test.ts). */
  markdown?: string
  icon: BlockIconSpec
  /**
   * Who may insert it. Absent: everyone who can edit the post. An `advanced` entry is
   * admins only unless it says otherwise. The menus only hide it: whatever must be
   * enforced is enforced by the server (Custom HTML, #428).
   */
  roles?: readonly CatalogRole[]
  /** Goes in the line rather than as a block (#422): any slot that holds text takes it. */
  inline?: boolean
  /** Set on a theme block: offered only while that theme is active. */
  theme?: string
  /**
   * Set on a plugin block (#452): the plugin's slug. Never a theme's, so a plugin block is
   * offered whichever theme is active; the enabled-plugins filter comes with the registry
   * (docs/design/plugin-system.md 4.3).
   */
  plugin?: string
  /** False while the site has switched this block off (an embed provider off Allowed embeds, #425). */
  available?: () => boolean
  insert: (editor: Editor, range: InsertRange) => void
  /** Turns the block holding the selection into this one (Turn into, the block-type toolbar). */
  turnInto?: (editor: Editor) => void
}

// The design's icons ("Inserting blocks"): 24×24, stroke 2, round caps.
export const ICONS = {
  text: "M4 7V5h16v2M9 19h6M12 5v14",
  ul: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  ol: "M10 6h10M10 12h10M10 18h10M4 4h1v4M4 8h2M4 14h2l-2 3h2",
  quote: "M3 18c3 0 6-2 6-7V6H3v6h4M14 18c3 0 6-2 6-7V6h-6v6h4",
  code: "m16 18 6-6-6-6M8 6l-6 6 6 6",
  image: "M3 3h18v18H3zM8.5 8.5h.01M21 15l-5-5L5 21",
  divider: "M3 12h18M8 6h8M8 18h8",
  html: "M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16",
  group: "M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M8 8h8v8H8z",
  // #419 (the blocks canvas's "Editor · table, details, pull quote, callout" board)
  todo: "m3 7 2 2 4-4M3 17l2 2 4-4M13 7h8M13 17h8",
  pullQuote: "M4 3h16M4 21h16M7 15c2 0 3-1 3-4V8H6v3h3M14 15c2 0 3-1 3-4V8h-4v3h3",
  callout: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 16v-4M12 8h.01",
  table: TABLE_ICON,
  // #421, the canvas's Details tile.
  details: "M4 6l3 3-3 3M11 9h9M4 16h16",
  // #423 ("Editor · image, gallery, video, audio, file")
  video: MEDIA_BLOCK_ICONS.video,
  audio: MEDIA_BLOCK_ICONS.audio,
  file: MEDIA_BLOCK_ICONS.file,
  // #424, the canvas's Gallery tile.
  gallery: MEDIA_BLOCK_ICONS.gallery,
  // #427 ("Editor · cover, media & text")
  cover: MEDIA_BLOCK_ICONS.cover,
  mediaText: MEDIA_BLOCK_ICONS.media_text,
  // #426 ("Editor · columns, group, buttons, spacer")
  columns: COLUMNS_ICON,
  buttons: "M3 8h18v8H3zM8 12h8",
  spacer: "M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4",
  // #422, the canvas's Footnote tile.
  footnote: "M4 8h11M4 13h11M4 18h7M17 4h2v5M17 9h4",
} as const

const chain = (editor: Editor, range: InsertRange) => editor.chain().focus().deleteRange(range)

/** The type of the list nearest the selection ("bulletList", "orderedList", "taskList"), or null. */
function closestList(editor: Editor): string | null {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name
    if (name === "bulletList" || name === "orderedList" || name === "taskList") return name
  }
  return null
}

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const

// #425: resolving a link is for editors and admins, so the menus are too. A contributor can
// still move an embed someone else added.
const EMBED_ROLES: readonly CatalogRole[] = ["admin", "editor"]

// No `.focus()`: TipTap focuses the editor a frame later, which would take focus from the
// block's own link field.
const insertEmbed = (editor: Editor, range: InsertRange, provider: EmbedProvider | null) => {
  requestEmbedFieldFocus()
  if (!editor.chain().deleteRange(range).insertEmbedBlock(provider).run()) takeEmbedFieldFocus()
}

// Whether a provider's own entry makes sense here: one the site doesn't allow could only ever
// refuse its links. Unknown until the setting has been read, and then the API decides.
const embedProviderAllowed = (provider: EmbedProvider) => () => currentAllowedEmbeds()?.includes(provider) ?? true

const EMBED_ENTRY_PROVIDERS = ["youtube", "vimeo", "x"]

/** The catalog id of the embed entry for a stored provider: its own, or "Embed a link". */
export function embedEntryId(provider: unknown): string {
  return typeof provider === "string" && EMBED_ENTRY_PROVIDERS.includes(provider) ? `embed-${provider}` : "embed-link"
}

export const CORE_BLOCKS: readonly CatalogEntry[] = [
  // Text
  {
    id: "paragraph",
    type: "paragraph",
    name: "Paragraph",
    group: "text",
    keywords: ["text", "plain"],
    icon: { path: ICONS.text },
    insert: (editor, range) => chain(editor, range).setParagraph().run(),
    turnInto: (editor) => editor.chain().focus().setParagraph().run(),
  },
  ...HEADING_LEVELS.map(
    (level): CatalogEntry => ({
      id: `heading-${level}`,
      type: "heading",
      name: `Heading ${level}`,
      group: "text",
      keywords: [`h${level}`, "title", "heading"],
      markdown: "#".repeat(level),
      icon: { glyph: `H${level}` },
      insert: (editor, range) => chain(editor, range).setHeading({ level }).run(),
      turnInto: (editor) => editor.chain().focus().setHeading({ level }).run(),
    })
  ),
  {
    id: "bullet-list",
    type: "bullet_list",
    name: "Bulleted list",
    group: "text",
    keywords: ["ul", "unordered", "bullets", "list"],
    markdown: "-",
    icon: { path: ICONS.ul },
    insert: (editor, range) => chain(editor, range).toggleBulletList().run(),
    // Toggling again would take an existing bulleted list apart.
    turnInto: (editor) => void (closestList(editor) !== "bulletList" && editor.chain().focus().toggleBulletList().run()),
  },
  {
    id: "numbered-list",
    type: "ordered_list",
    name: "Numbered list",
    group: "text",
    keywords: ["ol", "ordered", "list"],
    markdown: "1.",
    icon: { path: ICONS.ol },
    insert: (editor, range) => chain(editor, range).toggleOrderedList().run(),
    turnInto: (editor) => void (closestList(editor) !== "orderedList" && editor.chain().focus().toggleOrderedList().run()),
  },
  // #419: TipTap's TaskList; `[] ` is TaskItem's own input rule.
  {
    id: "todo-list",
    type: "todo_list",
    name: "To-do list",
    group: "text",
    keywords: ["todo", "checklist", "checkbox", "task", "list"],
    markdown: "[]",
    icon: { path: ICONS.todo },
    insert: (editor, range) => chain(editor, range).toggleTaskList().run(),
    turnInto: (editor) => void (closestList(editor) !== "taskList" && editor.chain().focus().toggleTaskList().run()),
  },
  {
    id: "quote",
    type: "blockquote",
    name: "Quote",
    group: "text",
    keywords: ["blockquote", "citation"],
    markdown: ">",
    icon: { path: ICONS.quote },
    insert: (editor, range) => chain(editor, range).setBlockquote().run(),
    turnInto: (editor) => editor.chain().focus().setBlockquote().run(),
  },
  // #419. The canvas's slash name is "/pull".
  {
    id: "pull-quote",
    type: "pull_quote",
    name: "Pull quote",
    group: "text",
    keywords: ["pullquote", "quote", "emphasis", "excerpt"],
    icon: { path: ICONS.pullQuote },
    insert: (editor, range) => chain(editor, range).setPullQuote().run(),
    turnInto: (editor) => editor.chain().focus().setPullQuote().run(),
  },
  // #419: the line becomes the callout's first paragraph.
  {
    id: "callout",
    type: "callout",
    name: "Callout",
    group: "text",
    keywords: ["note", "info", "tip", "warning", "danger", "success", "alert", "admonition", "notice"],
    icon: { path: ICONS.callout },
    insert: (editor, range) => chain(editor, range).setParagraph().setCallout().run(),
    turnInto: (editor) => void (!editor.isActive("callout") && editor.chain().focus().setParagraph().setCallout().run()),
  },
  {
    id: "code-block",
    type: "code_block",
    name: "Code",
    group: "text",
    keywords: ["codeblock", "snippet", "pre", "programming"],
    markdown: "```",
    icon: { path: ICONS.code },
    insert: (editor, range) => chain(editor, range).setCodeBlock().run(),
    turnInto: (editor) => editor.chain().focus().setCodeBlock().run(),
  },
  // #420: the size picker first ("Columns", "Rows", Create table); the table replaces the
  // line (now empty) when it's created, and nothing is inserted if it's closed.
  {
    id: "table",
    type: "table",
    name: "Table",
    group: "text",
    keywords: ["grid", "rows", "columns", "spreadsheet", "cells"],
    icon: { path: ICONS.table },
    insert: (editor, range) => {
      // No `.focus()`: TipTap focuses the editor a frame later, which would take focus
      // from the picker's first field.
      editor.chain().deleteRange(range).run()
      openTableSizePicker(editor)
    },
  },
  // #421, a container. The line it's typed on becomes its first block; the caret goes to
  // the summary. The canvas's slash name is "/details".
  {
    id: "details",
    type: "details",
    name: "Details",
    group: "text",
    keywords: ["toggle", "accordion", "collapse", "expand", "faq", "summary", "spoiler"],
    icon: { path: ICONS.details },
    insert: (editor, range) => chain(editor, range).setDetails().run(),
  },
  // #422: a reference at the caret and its note in the post's list, in one transaction; the
  // caret goes to the note. The canvas's slash name is "/footnote".
  {
    id: "footnote",
    type: "footnotes",
    name: "Footnote",
    group: "text",
    keywords: ["citation", "reference", "endnote", "source"],
    icon: { path: ICONS.footnote },
    inline: true,
    insert: (editor, range) => editor.chain().focus().insertFootnote(range).run(),
  },
  // Media
  {
    id: "image",
    type: "image",
    name: "Image",
    group: "media",
    keywords: ["img", "picture", "photo"],
    icon: { path: ICONS.image },
    insert: (editor, range) => createImagePlaceholder(editor, range),
  },
  // #424, a container of image blocks: an empty gallery on the line it's typed on, with its
  // Upload and Choose from Media. Images come from the picker's multi-select.
  {
    id: "gallery",
    type: "gallery",
    name: "Gallery",
    group: "media",
    keywords: ["images", "photos", "grid", "album"],
    icon: { path: ICONS.gallery },
    insert: (editor, range) => chain(editor, range).insertGallery().run(),
  },
  // #423: an empty block ("Upload" / "Choose from Media"); the file comes from the shared
  // media picker or an upload (blocks/mediaPicking.ts). The line it's typed on is replaced.
  {
    id: "video",
    type: "video",
    name: "Video",
    group: "media",
    keywords: ["movie", "clip", "mp4", "webm", "film"],
    icon: { path: ICONS.video },
    insert: (editor, range) => chain(editor, range).insertMediaBlock("video").run(),
  },
  {
    id: "audio",
    type: "audio",
    name: "Audio",
    group: "media",
    keywords: ["sound", "music", "podcast", "mp3", "recording"],
    icon: { path: ICONS.audio },
    insert: (editor, range) => chain(editor, range).insertMediaBlock("audio").run(),
  },
  {
    id: "file",
    type: "file",
    name: "File",
    group: "media",
    keywords: ["download", "pdf", "document", "attachment"],
    icon: { path: ICONS.file },
    insert: (editor, range) => chain(editor, range).insertMediaBlock("file").run(),
  },
  // #427, containers with one image: the line it's typed on becomes its first block.
  {
    id: "cover",
    type: "cover",
    name: "Cover",
    group: "media",
    keywords: ["hero", "banner", "background", "header image"],
    icon: { path: ICONS.cover },
    insert: (editor, range) => chain(editor, range).insertCover().run(),
  },
  {
    id: "media-text",
    type: "media_text",
    name: "Media & text",
    group: "media",
    keywords: ["image and text", "side by side", "picture", "split"],
    icon: { path: ICONS.mediaText },
    insert: (editor, range) => chain(editor, range).insertMediaText().run(),
  },
  // Layout
  {
    id: "divider",
    type: "divider",
    name: "Divider",
    group: "layout",
    keywords: ["hr", "horizontal rule", "separator", "line"],
    markdown: "---",
    icon: { path: ICONS.divider },
    insert: (editor, range) => chain(editor, range).setHorizontalRule().run(),
  },
  // #414: the first container. The line it's typed on becomes its first block.
  {
    id: "group",
    type: "group",
    name: "Group",
    group: "layout",
    keywords: ["section", "container", "box", "tint"],
    icon: { path: ICONS.group },
    insert: (editor, range) => chain(editor, range).setGroup().run(),
  },
  // #426. The layout picker first; the columns replace the line (now empty) when one is
  // picked, and nothing is inserted if it's closed, like the table's size picker.
  {
    id: "columns",
    type: "columns",
    name: "Columns",
    group: "layout",
    keywords: ["grid", "side by side", "row"],
    icon: { path: ICONS.columns },
    insert: (editor, range) => {
      // No `.focus()`: TipTap focuses the editor a frame later, which would take focus
      // from the picker.
      editor.chain().deleteRange(range).run()
      openColumnsPicker(editor)
    },
  },
  {
    id: "buttons",
    type: "buttons",
    name: "Buttons",
    group: "layout",
    keywords: ["button", "cta", "call to action"],
    icon: { path: ICONS.buttons },
    insert: (editor, range) => chain(editor, range).insertButtons().run(),
  },
  {
    id: "spacer",
    type: "spacer",
    name: "Spacer",
    group: "layout",
    keywords: ["space", "gap", "margin", "empty"],
    icon: { path: ICONS.spacer },
    insert: (editor, range) => chain(editor, range).insertSpacer().run(),
  },
  // Embeds (#425): an empty block whose field takes the pasted link; the canvas's slash
  // names are /youtube, /vimeo, /x and /embed.
  {
    id: "embed-youtube",
    type: "embed",
    name: "YouTube",
    group: "embeds",
    keywords: ["video", "yt", "embed"],
    icon: { path: EMBED_ICONS.youtube },
    roles: EMBED_ROLES,
    available: embedProviderAllowed("youtube"),
    insert: (editor, range) => insertEmbed(editor, range, "youtube"),
  },
  {
    id: "embed-vimeo",
    type: "embed",
    name: "Vimeo",
    group: "embeds",
    keywords: ["video", "embed"],
    icon: { path: EMBED_ICONS.vimeo },
    roles: EMBED_ROLES,
    available: embedProviderAllowed("vimeo"),
    insert: (editor, range) => insertEmbed(editor, range, "vimeo"),
  },
  {
    id: "embed-x",
    type: "embed",
    name: "X",
    group: "embeds",
    keywords: ["twitter", "tweet", "post", "embed"],
    icon: { path: EMBED_ICONS.x },
    roles: EMBED_ROLES,
    available: embedProviderAllowed("x"),
    insert: (editor, range) => insertEmbed(editor, range, "x"),
  },
  {
    id: "embed-link",
    type: "embed",
    name: "Embed a link",
    group: "embeds",
    keywords: ["url", "oembed", "codepen", "soundcloud", "spotify"],
    icon: { path: EMBED_ICONS.link },
    roles: EMBED_ROLES,
    insert: (editor, range) => insertEmbed(editor, range, null),
  },
  // Advanced (#428): an `advanced` entry is admins only (`entryRoles`). That only hides it:
  // the markup is written through admin-only API routes, so the server is what enforces it.
  // No `.focus()`: TipTap focuses the editor a frame later, taking focus from the code field.
  {
    id: "html",
    type: "html",
    name: "Custom HTML",
    group: "advanced",
    keywords: ["embed code", "markup", "snippet", "raw"],
    icon: { path: ICONS.html },
    insert: (editor, range) => {
      requestHtmlFieldFocus()
      if (!editor.chain().deleteRange(range).insertHtmlBlock().run()) takeHtmlFieldFocus()
    },
  },
]

/** The whole catalog: the core blocks, then every installed theme block (lib/theme-blocks). */
export function catalogEntries(): CatalogEntry[] {
  return [...CORE_BLOCKS, ...installedThemeBlockEditors.map((editor) => editor.entry)]
}

// --- Who sees what -----------------------------------------------------------------

/** The roles that may insert `entry`, or null for everyone who can edit the post. */
export function entryRoles(entry: CatalogEntry): readonly CatalogRole[] | null {
  return entry.roles ?? (entry.group === "advanced" ? ["admin"] : null)
}

/** True when the menus show the "Admins" pill on `entry`. */
export function isAdminOnly(entry: CatalogEntry): boolean {
  const roles = entryRoles(entry)
  return !!roles && roles.length === 1 && roles[0] === "admin"
}

export function canInsert(entry: CatalogEntry, role: string | null | undefined): boolean {
  const roles = entryRoles(entry)
  if (!roles) return true
  return !!role && (roles as readonly string[]).includes(role.toLowerCase())
}

export interface MenuContext {
  /** The signed-in user's role (a UI hint: the server enforces what matters). */
  role?: string | null
  /** The active theme's slug: only its theme blocks are offered. */
  theme?: string | null
  /** The slot being inserted into accepts this block (#414's nesting table). */
  accepts?: (entry: CatalogEntry) => boolean
}

/** The entries a menu offers in `context`, in catalog order. */
export function menuEntries(context: MenuContext, entries: readonly CatalogEntry[] = catalogEntries()): CatalogEntry[] {
  return entries.filter(
    (entry) =>
      canInsert(entry, context.role) &&
      (entry.available?.() ?? true) &&
      (!entry.theme || entry.theme === (context.theme ?? "default")) &&
      (context.accepts?.(entry) ?? true)
  )
}

/**
 * What the slot holding the selection accepts (#414's nesting table), for `MenuContext.accepts`:
 * the block the caret is in sits at the top level (every container allowed there), in a
 * container (only what it may hold: no group in a group), or inside another block's own
 * content (a list item, a quote, a theme block), where no container can go, or in one that
 * holds paragraphs only (a callout, a to-do item), where only a paragraph can.
 */
export function slotAcceptsAt(editor: Editor): (entry: CatalogEntry) => boolean {
  const { $from } = editor.state.selection
  const parent = $from.depth > 1 ? $from.node($from.depth - 1) : null
  // In the line (#422): whatever the block, if its text takes the node.
  const inlineFits = (entry: CatalogEntry) => !!entry.inline && acceptsFootnoteRef(editor.state, $from.pos)
  // A block that holds paragraphs only (a callout, a to-do item, #419; a table cell, #420):
  // any other entry would delete the typed /query and then fail to make its block there.
  if (parent && parent.type.spec.content === "paragraph+") return (entry) => entry.type === "paragraph" || inlineFits(entry)
  const holder = parent?.type.name ?? "doc"
  return (entry) => (entry.inline ? inlineFits(entry) : holderAcceptsType(holder, entry.type))
}

// The active theme, set by ThemeProvider when the admin loads (only its blocks are
// offered; every installed one stays in the editor's schema, #376).
let activeTheme = "default"

export function setActiveTheme(slug: string) {
  activeTheme = slug
}

export function getActiveTheme(): string {
  return activeTheme
}

// --- Search ------------------------------------------------------------------------

export interface CatalogMatch {
  entry: CatalogEntry
  /** The part of the name the query matched, [start, end), to show in bold. */
  nameMatch?: [number, number]
  /** The keyword the query matched, when the name didn't. */
  keyword?: string
}

export interface CatalogSection {
  group: BlockGroup
  label: string
  matches: CatalogMatch[]
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim()
const isWordChar = (char: string | undefined) => !!char && /[\p{L}\p{N}]/u.test(char)

/**
 * How `entry` matches `query` (normalized), or null. A name matches where a word of it
 * starts with the query ("/vid" → **Vid**eo; "/list" → Bulleted **list**), never inside a
 * word ("/h" isn't Paragrap**h**); a keyword matches when it starts with the query
 * ("/vid" → YouTube, "video"). An empty query matches everything.
 */
export function matchEntry(entry: CatalogEntry, query: string): CatalogMatch | null {
  const q = normalize(query)
  if (!q) return { entry }
  const name = entry.name.toLowerCase()
  for (let at = name.indexOf(q); at !== -1; at = name.indexOf(q, at + 1)) {
    if (!isWordChar(name[at - 1]) || !isWordChar(name[at])) return { entry, nameMatch: [at, at + q.length] }
  }
  const keyword = entry.keywords?.find((k) => normalize(k).startsWith(q))
  return keyword ? { entry, keyword } : null
}

/**
 * The menu's contents for `query`: the matching entries in their groups, groups in the
 * design's order, entries in catalog order, empty groups left out. No cap: the list
 * scrolls.
 */
export function searchCatalog(entries: readonly CatalogEntry[], query: string): CatalogSection[] {
  const matches = entries.map((entry) => matchEntry(entry, query)).filter((m): m is CatalogMatch => m !== null)
  return BLOCK_GROUPS.map(({ id, label }) => ({ group: id, label, matches: matches.filter((m) => m.entry.group === id) })).filter(
    (section) => section.matches.length > 0
  )
}

/** The sections' entries in screen order: what ↑↓ walk through, across groups. */
export function flattenSections(sections: readonly CatalogSection[]): CatalogMatch[] {
  return sections.flatMap((section) => section.matches)
}

// --- Turn into ---------------------------------------------------------------------

/** The entries a block can be turned into, in menu order. */
export function turnIntoEntries(entries: readonly CatalogEntry[] = CORE_BLOCKS): CatalogEntry[] {
  return entries.filter((entry) => entry.turnInto)
}

export function findEntry(id: string, entries: readonly CatalogEntry[] = catalogEntries()): CatalogEntry | undefined {
  return entries.find((entry) => entry.id === id)
}
