import type { NavIcon } from "@gl-admin/components/sidebar/nav"
import { capitalize } from "@gl-admin/utils/formatting"
import { mediaKind } from "./mediaLibrary"
import { canCreateContent, isSiteAdmin, roleLabel } from "./roles"
import { singularTaxonomyLabel } from "./taxonomyAdmin"
import type { CommandPalettePost, CommandPaletteResults, CommandPaletteTerm, CommandPaletteUser } from "./api/commandPalette"
import type { Media } from "./api/types"

// The command palette (#41; the canvas's "Search · command palette"), as data: which jump
// actions a role gets, what each result opens and the order of the groups. Pure, so the
// rules are tested without a dialog (commandPalette.test.ts). The roles here are a UI hint
// (lib/roles.ts): what a search may return is decided by the API.

/** How long typing pauses before the palette asks the API. */
export const COMMAND_PALETTE_DEBOUNCE_MS = 150

const COMMAND_PALETTE_OPEN = "gl:command-palette-open"

/** Opens the palette from anywhere: the sidebar's Search button, for one. */
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN))
}

/** Calls `open` whenever something asks for the palette. Returns the unsubscribe. */
export function onCommandPaletteOpen(open: () => void): () => void {
  window.addEventListener(COMMAND_PALETTE_OPEN, open)
  return () => window.removeEventListener(COMMAND_PALETTE_OPEN, open)
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** The shortcut as the sidebar shows it. */
export const COMMAND_PALETTE_SHORTCUT = isMac ? "⌘ K" : "Ctrl K"

export function isCommandPaletteShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): boolean {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k"
}

/**
 * Whether the block editor has focus (its text, or a field inside a block). There Ctrl K
 * stays the editor's own: it opens the link dialog (#41's decision).
 */
export function isEditorFocused(active: Element | null): boolean {
  return !!active?.closest(".ProseMirror")
}

export interface PaletteOptionBase {
  key: string
  label: string
  to: string
  /** The part of the label that matched, in bold. */
  match?: [number, number]
  /** On the right: a status, a kind, a role. */
  meta?: string
}

export type PaletteOption =
  | (PaletteOptionBase & { kind: "action"; icon: NavIcon })
  | (PaletteOptionBase & { kind: "post"; icon: "post" | "page" })
  | (PaletteOptionBase & { kind: "media"; media: Media })
  | (PaletteOptionBase & { kind: "term" })
  | (PaletteOptionBase & { kind: "user"; user: CommandPaletteUser })

export interface PaletteSection {
  id: string
  label: string
  options: PaletteOption[]
}

type Access = (role: string | null | undefined) => boolean

// Who sees an action mirrors the guard of the page it opens (app.tsx, nav.ts).
const ACTIONS: { key: string; label: string; to: string; icon: NavIcon; access: Access }[] = [
  { key: "new-post", label: "New post", to: "/content/post/new", icon: "new", access: canCreateContent },
  { key: "new-page", label: "New page", to: "/content/page/new", icon: "page", access: canCreateContent },
  { key: "settings", label: "Settings", to: "/settings", icon: "settings", access: isSiteAdmin },
  { key: "media", label: "Media", to: "/media", icon: "media", access: canCreateContent },
  { key: "users", label: "Users", to: "/users", icon: "users", access: isSiteAdmin },
]

/** The jump actions this role may use. */
export function paletteActions(role: string | null | undefined): PaletteOption[] {
  return ACTIONS.filter((action) => action.access(role)).map(({ key, label, to, icon }) => ({
    kind: "action",
    key: `action-${key}`,
    label,
    to,
    icon,
  }))
}

// Where the query starts a word of the label, as the slash menu matches names.
function wordStartMatch(label: string, query: string): [number, number] | undefined {
  const lower = label.toLowerCase()
  for (let at = lower.indexOf(query); at !== -1; at = lower.indexOf(query, at + 1)) {
    if (at === 0 || /\s/.test(lower[at - 1])) return [at, at + query.length]
  }
  return undefined
}

// Where the query is in a result's label, if it's there at all: a hit by slug has none.
function resultMatch(label: string, query: string): [number, number] | undefined {
  const at = label.toLowerCase().indexOf(query)
  return at === -1 ? undefined : [at, at + query.length]
}

function postOption(post: CommandPalettePost, query: string, icon: "post" | "page"): PaletteOption {
  const label = post.title.trim() || "Untitled"
  return {
    kind: "post",
    key: `${icon}-${post.id}`,
    label,
    to: `/content/edit/${post.id}`,
    match: resultMatch(label, query),
    meta: capitalize(post.post_status),
    icon,
  }
}

const MEDIA_KIND_LABELS: Record<ReturnType<typeof mediaKind>, string> = {
  image: "Image",
  vector: "Image",
  video: "Video",
  audio: "Audio",
  file: "File",
}

function mediaOption(media: Media, query: string): PaletteOption {
  const label = media.name.trim() || "Untitled"
  return { kind: "media", key: `media-${media.id}`, label, to: `/media/${media.id}`, match: resultMatch(label, query), meta: MEDIA_KIND_LABELS[mediaKind(media)], media }
}

function termOption(term: CommandPaletteTerm, query: string): PaletteOption {
  return {
    kind: "term",
    key: `term-${term.id}`,
    label: term.name,
    to: `/taxonomies?type=${encodeURIComponent(term.taxonomy_type)}&term=${term.id}`,
    match: resultMatch(term.name, query),
    meta: capitalize(singularTaxonomyLabel({ label: term.taxonomy_label, name: term.taxonomy_type })),
  }
}

function userOption(user: CommandPaletteUser, query: string): PaletteOption {
  const label = user.full_name.trim() || user.username
  return { kind: "user", key: `user-${user.id}`, label, to: `/users/edit/${user.id}`, match: resultMatch(label, query), meta: roleLabel(user.role), user }
}

/**
 * The palette's groups: the actions that match first (they need no answer from the API, so
 * the row under the highlight doesn't move when results arrive), then Posts, Pages, Media,
 * Terms and Users. An empty group is left out; nothing typed shows the actions alone.
 */
export function paletteSections({
  query,
  actions,
  results,
}: {
  query: string
  actions: readonly PaletteOption[]
  results: CommandPaletteResults | null
}): PaletteSection[] {
  const q = query.trim().toLowerCase()
  const matched = q
    ? actions.flatMap((action) => {
        const match = wordStartMatch(action.label, q)
        return match ? [{ ...action, match }] : []
      })
    : [...actions]
  const sections: PaletteSection[] = [
    { id: "actions", label: "Jump to", options: matched },
    { id: "posts", label: "Posts", options: (results?.posts ?? []).map((p) => postOption(p, q, "post")) },
    { id: "pages", label: "Pages", options: (results?.pages ?? []).map((p) => postOption(p, q, "page")) },
    { id: "media", label: "Media", options: (results?.media ?? []).map((m) => mediaOption(m, q)) },
    { id: "terms", label: "Terms", options: (results?.terms ?? []).map((t) => termOption(t, q)) },
    { id: "users", label: "Users", options: (results?.users ?? []).map((u) => userOption(u, q)) },
  ]
  return sections.filter((section) => section.options.length > 0)
}

/** Every option in screen order: what the arrow keys walk through. */
export function flattenPaletteSections(sections: readonly PaletteSection[]): PaletteOption[] {
  return sections.flatMap((section) => section.options)
}
