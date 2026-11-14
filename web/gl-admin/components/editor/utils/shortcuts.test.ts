import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { isCommandPaletteShortcut } from "@gl-admin/lib/commandPalette"
import { BlockActions } from "./blockActions"
import { BlockNavigationKeys, BlockSelectionKeys } from "../extensions/BlockNavigation"
import { FloatingToolbarKeys } from "./floatingToolbar"
import { OpenLinkModal } from "../extensions/OpenLinkModal"
import {
  KEYS,
  MARK_SHORTCUTS,
  editorKeysHint,
  formatKeys,
  isShortcutReferenceKey,
  shortcutSections,
} from "./shortcuts"

// The shortcut reference (#477) lists the keys the editor binds. The block keys, ⌥F10 and
// the link are bound from these same strings; the marks are TipTap's (and InlineMarks'),
// so each one is pressed here in a real editor and must toggle its mark.

/** A keydown for a ProseMirror key name, as the browser sends it off a Mac (jsdom isn't one). */
function keydown(keys: string): KeyboardEvent {
  const parts = keys.split(/-(?!$)/)
  const key = parts.pop()!
  const mods = new Set(parts)
  return new KeyboardEvent("keydown", {
    key,
    ctrlKey: mods.has("Mod") || mods.has("Ctrl"),
    shiftKey: mods.has("Shift"),
    altKey: mods.has("Alt"),
    bubbles: true,
    cancelable: true,
  })
}

describe("formatKeys", () => {
  it("writes keys as Windows and Linux show them", () => {
    expect(formatKeys(KEYS.moveTo, false)).toBe("Ctrl Shift P")
    expect(formatKeys(KEYS.duplicate, false)).toBe("Ctrl D")
    expect(formatKeys(KEYS.floatingToolbar, false)).toBe("Alt F10")
    expect(formatKeys(KEYS.moveBlockUp, false)).toBe("Ctrl Shift ↑")
    expect(formatKeys(KEYS.blockSettings, false)).toBe("Ctrl Shift ,")
    expect(formatKeys(KEYS.selectBlock, false)).toBe("Esc")
    expect(formatKeys(KEYS.enterBlock, false)).toBe("↵")
  })

  it("writes them as a Mac shows them, in Apple's modifier order", () => {
    expect(formatKeys(KEYS.moveTo, true)).toBe("⇧⌘P")
    expect(formatKeys(KEYS.comment, true)).toBe("⌘M")
    expect(formatKeys(KEYS.floatingToolbar, true)).toBe("⌥F10")
    expect(formatKeys("Mod-.", true)).toBe("⌘.")
  })

  it("spells them out for screen readers", () => {
    expect(formatKeys(KEYS.moveBlockDown, false, true)).toBe("Ctrl Shift Down arrow")
    // Apple's order, as VoiceOver reads ⇧⌘P.
    expect(formatKeys(KEYS.moveTo, true, true)).toBe("Shift Command P")
    expect(formatKeys(KEYS.floatingToolbar, true, true)).toBe("Option F10")
    expect(formatKeys("Mod-,", false, true)).toBe("Ctrl comma")
    expect(formatKeys("?", false, true)).toBe("question mark")
  })
})

describe("the reference lists what the editor binds", () => {
  let editor: Editor
  const opened: string[] = []

  beforeEach(() => {
    opened.length = 0
    editor = new Editor({
      element: document.createElement("div"),
      extensions: [
        ...Object.values(schemaExtensions({ collaborating: false })),
        BlockSelectionKeys,
        BlockNavigationKeys,
        BlockActions,
        FloatingToolbarKeys,
        OpenLinkModal.configure({ onOpen: () => opened.push("link") }),
      ],
      content: {
        type: "doc",
        content: [{ type: "paragraph", attrs: { "data-block-id": "blk-0477-keys-00001" }, content: [{ type: "text", text: "alpha beta" }] }],
      },
    })
  })
  afterEach(() => editor.destroy())

  const press = (keys: string) => !!editor.view.someProp("handleKeyDown", (f) => f(editor.view, keydown(keys)))

  it.each(MARK_SHORTCUTS.map((m) => [m.label, m]))("%s toggles its mark", (_label, { mark, keys }) => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 6)))
    expect(editor.isActive(mark)).toBe(false)
    expect(press(keys)).toBe(true)
    expect(editor.isActive(mark)).toBe(true)
  })

  it("the block menu's Ctrl D duplicates the block", () => {
    editor.commands.setTextSelection(3)
    expect(press(KEYS.duplicate)).toBe(true)
    expect(editor.state.doc.childCount).toBe(2)
  })

  it("Esc selects the block, and the link key opens the link dialog", () => {
    editor.commands.setTextSelection(3)
    expect(press(KEYS.selectBlock)).toBe(true)
    expect(editor.state.selection.from).toBe(0)
    editor.commands.setTextSelection(3)
    expect(press(KEYS.link)).toBe(true)
    expect(opened).toEqual(["link"])
  })

  it("outside the text the same key is the command palette's", () => {
    expect(isCommandPaletteShortcut(keydown(KEYS.commandPalette))).toBe(true)
  })

  it("every row names at least one key, and the sections cover the issue's list", () => {
    const all = shortcutSections().flatMap((s) => s.rows.flatMap((r) => r.keys))
    for (const key of [
      KEYS.floatingToolbar,
      KEYS.selectBlock,
      KEYS.enterBlock,
      KEYS.previousBlock,
      KEYS.nextBlock,
      KEYS.duplicate,
      KEYS.moveTo,
      KEYS.comment,
      KEYS.link,
      ...MARK_SHORTCUTS.map((m) => m.keys),
    ]) {
      expect(all).toContain(key)
    }
    expect(shortcutSections().every((s) => s.rows.every((r) => r.keys.length > 0))).toBe(true)
  })
})

describe("the ? key", () => {
  const event = (target: Element | null, init: Partial<KeyboardEvent> = {}) =>
    ({ key: "?", ctrlKey: false, metaKey: false, altKey: false, target, ...init }) as KeyboardEvent

  it("opens the reference outside anything that takes text", () => {
    const button = document.createElement("button")
    expect(isShortcutReferenceKey(event(button))).toBe(true)
    expect(isShortcutReferenceKey(event(document.body))).toBe(true)
  })

  it("types a ? in fields, the editor's text and comboboxes", () => {
    const input = document.createElement("input")
    const textarea = document.createElement("textarea")
    const editable = document.createElement("div")
    // jsdom doesn't reflect the contentEditable property.
    editable.setAttribute("contenteditable", "true")
    const inside = document.createElement("span")
    editable.appendChild(inside)
    for (const target of [input, textarea, editable, inside]) expect(isShortcutReferenceKey(event(target))).toBe(false)
  })

  it("leaves Ctrl ? and other keys alone", () => {
    expect(isShortcutReferenceKey(event(document.body, { ctrlKey: true }))).toBe(false)
    expect(isShortcutReferenceKey(event(document.body, { key: "/" }))).toBe(false)
  })
})

describe("the text's description", () => {
  it("names the toolbar key and where every key is listed", () => {
    expect(editorKeysHint(false)).toBe(
      "Alt F10 moves to the toolbar. Escape selects the block. Every shortcut: question mark outside the text, or the block menu's Keyboard shortcuts."
    )
    expect(editorKeysHint(true)).toContain("Option F10 moves to the toolbar.")
  })
})
