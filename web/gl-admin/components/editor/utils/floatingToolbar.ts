import { Extension, type Editor } from "@tiptap/core"
import type React from "react"
import { nextRovingIndex } from "@gl-admin/components/ui/a11y"

// Keyboard access to the editor's floating toolbars (#144): the selection's bubble menu
// ("Format text"), the block-type toolbar and the media, embed and Custom HTML toolbars.
// They float over the text, outside the tab order a writer walks through, so:
//   - ⌥F10 / Alt+F10 in the text moves focus to the first control of the toolbar that is
//     showing (the table's own ⌥F10 in a cell runs first, TableKeyboard);
//   - in a toolbar ← → move between its controls (Home and End to the ends), ⌥F10 goes to
//     the next toolbar showing (the block-type toolbar shows beside "Format text"), Esc
//     goes back to the text with the selection as it was.
// Each toolbar's element carries FLOATING_TOOLBAR_ATTR and calls `onFloatingToolbarKeyDown`.
// Toolbars inside block node views (`data-block-toolbar`, #417) have their own keys.
//
// This is a keymap only: no plugin state, no appendTransaction, nothing that reacts to a
// sync (collaboration rule 7), and it changes nothing in the document.

export const FLOATING_TOOLBAR_ATTR = "data-floating-toolbar"

const CONTROLS = "button:not([disabled]), input:not([disabled]), select:not([disabled])"

function isShowing(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) return false
  const style = getComputedStyle(el)
  return style.visibility !== "hidden" && style.display !== "none"
}

/** The toolbar's controls in order, leaving out those inside an open list (CommandSelect). */
export function toolbarControls(toolbar: HTMLElement): HTMLElement[] {
  return Array.from(toolbar.querySelectorAll<HTMLElement>(CONTROLS)).filter(
    (el) => !el.closest('[role="listbox"]') && el.getAttribute("aria-hidden") !== "true"
  )
}

/**
 * The floating toolbars showing for `editor`, the selection's ("Format text",
 * FLOATING_TOOLBAR_ATTR = "selection") first: with text selected it's the one a writer
 * wants, though the block-type toolbar shows too.
 */
export function visibleFloatingToolbars(editor: Editor): HTMLElement[] {
  const dom = editor.view.dom as HTMLElement
  // The toolbars render beside the editor's DOM (TipTap's BubbleMenu), not inside it.
  const scope = dom.closest(".editor-wrapper") ?? dom.parentElement?.parentElement ?? document
  const toolbars = Array.from(scope.querySelectorAll<HTMLElement>(`[${FLOATING_TOOLBAR_ATTR}]`))
  const rank = (t: HTMLElement) => (t.getAttribute(FLOATING_TOOLBAR_ATTR) === "selection" ? 0 : 1)
  return toolbars
    .filter((t) => isShowing(t) && toolbarControls(t).length > 0)
    .sort((a, b) => rank(a) - rank(b))
}

/**
 * Moves focus to the first control of a showing toolbar: the first one, or the one after
 * `from` (⌥F10 again inside a toolbar). False when none is showing.
 */
export function focusFloatingToolbar(editor: Editor, from?: HTMLElement): boolean {
  const toolbars = visibleFloatingToolbars(editor)
  const toolbar = from ? toolbars[(toolbars.indexOf(from) + 1) % toolbars.length] : toolbars[0]
  const first = toolbar && toolbarControls(toolbar)[0]
  if (!first) return false
  first.focus()
  return true
}

/** ← → Home End between the toolbar's controls, Esc back to the text. */
export function onFloatingToolbarKeyDown(event: React.KeyboardEvent<HTMLElement>, editor: Editor) {
  const toolbar = event.currentTarget
  const target = event.target as HTMLElement
  // Keys typed into a field (a link, an alt text) or inside an open list stay theirs.
  if (target.closest('[role="listbox"]')) return
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  if (typing && event.key !== "Escape") return
  if (event.key === "Escape") {
    event.preventDefault()
    event.stopPropagation()
    // The view's own focus, at once: the selection is the state's and stays as it was
    // (TipTap's focus command waits for an animation frame).
    editor.view.focus()
    return
  }
  if (event.key === "F10" && event.altKey) {
    event.preventDefault()
    focusFloatingToolbar(editor, toolbar)
    return
  }
  const controls = toolbarControls(toolbar)
  const next = nextRovingIndex(event.key, controls.indexOf(target), controls.length, "horizontal")
  if (next === null) return
  event.preventDefault()
  controls[next]?.focus()
}

/** ⌥F10 / Alt+F10 in the text focuses the floating toolbar that is showing. */
export const FloatingToolbarKeys = Extension.create({
  name: "floatingToolbarKeys",
  addKeyboardShortcuts() {
    return {
      "Alt-F10": () => focusFloatingToolbar(this.editor),
    }
  },
})
