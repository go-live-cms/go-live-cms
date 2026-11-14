/**
 * Whether "Mod" is ⌘: prosemirror-keymap's own test (an iPad or iPhone with a keyboard
 * too), not TipTap's isMacOS, which only matches "Mac" and would label ⌘ keys "Ctrl".
 */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform)
}

// The editor's keyboard shortcuts in one place (#477): the keymaps bind these strings
// (floatingToolbar.ts, BlockNavigation.ts, blockActions.ts, OpenLinkModal.ts), the block
// menu shows them, and the shortcut reference (ui/ShortcutReference.tsx) lists them, so
// the reference can't say one thing while the editor does another. The marks are TipTap's
// own bindings (and InlineMarks.ts's exact ⌘. / ⌘,); `shortcuts.test.ts` presses each one
// in a real editor and checks it toggles its mark.
//
// Keys are ProseMirror keymap names: "Mod" is ⌘ on a Mac and Ctrl elsewhere.

export const KEYS = {
  floatingToolbar: "Alt-F10",
  selectBlock: "Escape",
  enterBlock: "Enter",
  previousBlock: "ArrowUp",
  nextBlock: "ArrowDown",
  moveBlockUp: "Mod-Shift-ArrowUp",
  moveBlockDown: "Mod-Shift-ArrowDown",
  deleteBlock: "Backspace",
  deleteBlockForward: "Delete",
  blockSettings: "Mod-Shift-,",
  duplicate: "Mod-d",
  comment: "Mod-m",
  moveTo: "Mod-Shift-p",
  link: "Mod-k",
  // Outside the editor's text, the same keys open the command palette
  // (lib/commandPalette.ts isCommandPaletteShortcut).
  commandPalette: "Mod-k",
} as const

/** The marks and their keys, in the selection toolbar's order (BubbleMenu.tsx). */
export const MARK_SHORTCUTS = [
  { mark: "bold", label: "Bold", keys: "Mod-b" },
  { mark: "italic", label: "Italic", keys: "Mod-i" },
  { mark: "underline", label: "Underline", keys: "Mod-u" },
  { mark: "strike", label: "Strikethrough", keys: "Mod-Shift-s" },
  { mark: "code", label: "Inline code", keys: "Mod-e" },
  { mark: "highlight", label: "Highlight", keys: "Mod-Shift-h" },
  { mark: "superscript", label: "Superscript", keys: "Mod-." },
  { mark: "subscript", label: "Subscript", keys: "Mod-," },
] as const

const KEY_NAMES: Record<string, string> = {
  Escape: "Esc",
  Enter: "↵",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backspace: "⌫",
  Delete: "Del",
}

// What a screen reader should say for a key whose symbol it may skip or misread.
const SPOKEN_NAMES: Record<string, string> = {
  Escape: "Escape",
  Enter: "Enter",
  ArrowUp: "Up arrow",
  ArrowDown: "Down arrow",
  ArrowLeft: "Left arrow",
  ArrowRight: "Right arrow",
  Backspace: "Backspace",
  Delete: "Delete",
  ".": "period",
  ",": "comma",
  "/": "slash",
  "?": "question mark",
  "@": "at sign",
}

/**
 * "Mod-Shift-p" as a person reads it: "Ctrl Shift P", or "⇧⌘P" on a Mac (Apple's order:
 * ⌃ ⌥ ⇧ ⌘, then the key). `spoken`: in words, for screen readers ("Command Shift P",
 * "Ctrl Up arrow").
 */
export function formatKeys(keys: string, mac: boolean = isMacPlatform(), spoken = false): string {
  // The key itself may be "-" or ","; split off the modifiers only.
  const parts = keys.split(/-(?!$)/)
  const key = parts.pop() ?? ""
  const mods = new Set(parts.map((m) => (m === "Mod" ? (mac ? "Meta" : "Ctrl") : m === "Cmd" ? "Meta" : m === "Control" ? "Ctrl" : m)))
  const name = (spoken && SPOKEN_NAMES[key]) || KEY_NAMES[key] || (key.length === 1 ? key.toUpperCase() : key)
  if (mac && !spoken) {
    const symbols = [mods.has("Ctrl") && "⌃", mods.has("Alt") && "⌥", mods.has("Shift") && "⇧", mods.has("Meta") && "⌘"].filter(Boolean)
    return `${symbols.join("")}${name}`
  }
  const words = mac
    ? [mods.has("Ctrl") && "Control", mods.has("Alt") && "Option", mods.has("Shift") && "Shift", mods.has("Meta") && "Command"]
    : [mods.has("Ctrl") && "Ctrl", mods.has("Alt") && "Alt", mods.has("Shift") && "Shift", mods.has("Meta") && "Windows"]
  return [...words, name].filter(Boolean).join(" ")
}

export interface ShortcutRow {
  /** One or more alternatives ("↑ / ↓"), each a ProseMirror key name. */
  keys: readonly string[]
  label: string
}

export interface ShortcutSection {
  title: string
  rows: ShortcutRow[]
}

/** What the shortcut reference lists, from the keys above. */
export function shortcutSections(): ShortcutSection[] {
  return [
    {
      title: "Toolbars",
      rows: [{ keys: [KEYS.floatingToolbar], label: "Move to the toolbar showing; ← → inside it, Esc back to the text" }],
    },
    {
      title: "Blocks",
      rows: [
        { keys: [KEYS.selectBlock], label: "Select the block around the caret, then its container" },
        { keys: [KEYS.enterBlock], label: "On a selected block: edit it, or step into a container" },
        { keys: [KEYS.previousBlock, KEYS.nextBlock], label: "On a selected block: the block before or after it" },
        { keys: [KEYS.moveBlockUp, KEYS.moveBlockDown], label: "Move the block up or down" },
        { keys: [KEYS.deleteBlock, KEYS.deleteBlockForward], label: "On a selected block: delete it" },
        { keys: [KEYS.duplicate], label: "Duplicate the block" },
        { keys: [KEYS.moveTo], label: "Move the block under a heading" },
        { keys: [KEYS.comment], label: "Comment on the block" },
        { keys: [KEYS.blockSettings], label: "Open or close the block's settings" },
        { keys: ["Tab"], label: "From the text: the block's + and menu, then its own toolbar" },
      ],
    },
    {
      title: "Text",
      rows: [
        { keys: [KEYS.link], label: "Add or edit a link" },
        ...MARK_SHORTCUTS.map((m) => ({ keys: [m.keys], label: m.label })),
        { keys: ["/"], label: "At the start of a line: insert a block" },
        { keys: ["@"], label: "Mention someone, link a post or add a date" },
      ],
    },
    {
      title: "Outside the text",
      rows: [
        { keys: [KEYS.commandPalette], label: "Search and jump (command palette)" },
        { keys: ["?"], label: "In the editor, outside a field: this list" },
      ],
    },
  ]
}

/**
 * The editable text's accessible description (Editor.tsx): the keys out of it, so a
 * screen reader user hears where the toolbars are without opening the reference.
 */
export function editorKeysHint(mac: boolean = isMacPlatform()): string {
  const say = (keys: string) => formatKeys(keys, mac, true)
  return `${say(KEYS.floatingToolbar)} moves to the toolbar. ${say(KEYS.selectBlock)} selects the block. Every shortcut: question mark outside the text, or the block menu's Keyboard shortcuts.`
}

const OPEN_EVENT = "gl:open-shortcut-reference"

/** Opens the shortcut reference (the block menu's Keyboard shortcuts). */
export function openShortcutReference(): void {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

/** Calls `open` whenever something asks for the reference. Returns the unsubscribe. */
export function onShortcutReferenceOpen(open: () => void): () => void {
  window.addEventListener(OPEN_EVENT, open)
  return () => window.removeEventListener(OPEN_EVENT, open)
}

/**
 * "?" opens the reference only where it would type nothing: not in a field, the editor's
 * text or anything else editable, nor in an open menu or list (their typeahead takes keys),
 * and without Ctrl, ⌘ or Alt.
 */
export function isShortcutReferenceKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "target">): boolean {
  if (event.key !== "?" || event.ctrlKey || event.metaKey || event.altKey) return false
  const target = event.target
  if (!(target instanceof Element)) return true
  if (
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox'], [role='menu'], [role='listbox']"
    )
  )
    return false
  return true
}
