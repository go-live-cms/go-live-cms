import type { Editor } from "@tiptap/core"
import { type ColumnsLayout } from "@gl-admin/lib/blocks-spec"

/**
 * The columns' layout picker (#426, the canvas's "Columns" empty state, "Pick a layout to
 * start."): a small dialog at the caret with the four layouts as radio buttons, each drawn
 * as its columns. Picking one inserts the columns for the line the caret is on
 * (`insertColumns`) and puts the caret in the first; Esc, or a click outside, closes it
 * without inserting anything and puts focus back in the text. Nothing reaches the shared
 * doc until a layout is picked, so a collaborator never sees a half-made block.
 *
 * Plain DOM, like the table's size picker (`TableSizePicker.ts`), whose position it shares.
 */
export const COLUMNS_PICKER_LAYOUTS: readonly { label: string; count: number; layout: ColumnsLayout; tracks: string }[] = [
  { label: "50 / 50", count: 2, layout: "50-50", tracks: "1fr 1fr" },
  { label: "33 / 33 / 33", count: 3, layout: "equal", tracks: "1fr 1fr 1fr" },
  { label: "33 / 67", count: 2, layout: "33-67", tracks: "1fr 2fr" },
  { label: "67 / 33", count: 2, layout: "67-33", tracks: "2fr 1fr" },
]

export const COLUMNS_ICON = "M3 4h7v16H3zM14 4h7v16h-7z"

export interface ColumnsPickerHandle {
  element: HTMLElement
  close: (options?: { refocus?: boolean }) => void
  /** Inserts the layout at `index` (what a click and ↵ do). */
  pick: (index: number) => void
}

let open: ColumnsPickerHandle | null = null

/** The picker that is open, if any (tests). */
export function currentColumnsPicker(): ColumnsPickerHandle | null {
  return open
}

export function openColumnsPicker(editor: Editor): ColumnsPickerHandle | null {
  open?.close({ refocus: false })
  if (!editor.isEditable) return null
  const doc = editor.view.dom.ownerDocument

  const dialog = doc.createElement("div")
  dialog.className = "editor-table-picker editor-columns-picker"
  dialog.setAttribute("role", "dialog")
  dialog.setAttribute("aria-label", "Pick a column layout")

  const head = doc.createElement("div")
  head.className = "editor-table-picker__head"
  head.textContent = "Columns"
  const hint = doc.createElement("p")
  hint.className = "editor-columns-picker__hint"
  hint.id = "gl-columns-picker-hint"
  hint.textContent = "Pick a layout to start."

  const group = doc.createElement("div")
  group.className = "editor-columns-picker__options"
  group.setAttribute("role", "radiogroup")
  group.setAttribute("aria-labelledby", hint.id)

  const options = COLUMNS_PICKER_LAYOUTS.map((choice, index) => {
    const option = doc.createElement("button")
    option.type = "button"
    option.className = "editor-columns-picker__option"
    option.setAttribute("role", "radio")
    option.setAttribute("aria-checked", "false")
    option.setAttribute("aria-label", choice.label)
    option.tabIndex = index === 0 ? 0 : -1
    const preview = doc.createElement("span")
    preview.className = "editor-columns-picker__preview"
    preview.setAttribute("aria-hidden", "true")
    preview.style.gridTemplateColumns = choice.tracks
    for (let cell = 0; cell < choice.count; cell++) preview.append(doc.createElement("span"))
    const name = doc.createElement("span")
    name.className = "editor-columns-picker__name"
    name.textContent = choice.label
    option.append(preview, name)
    option.addEventListener("click", () => handle.pick(index))
    group.append(option)
    return option
  })

  dialog.append(head, hint, group)

  try {
    const coords = editor.view.coordsAtPos(editor.state.selection.from)
    dialog.style.top = `${Math.round(coords.bottom + 6)}px`
    dialog.style.left = `${Math.round(coords.left)}px`
  } catch {
    // No layout (a headless test): the stylesheet's position applies.
  }

  const focusOption = (index: number) => {
    options.forEach((option, i) => (option.tabIndex = i === index ? 0 : -1))
    options[index].focus()
  }
  const onDocumentDown = (event: MouseEvent) => {
    if (!dialog.contains(event.target as globalThis.Node)) handle.close()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const at = options.indexOf(doc.activeElement as HTMLButtonElement)
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      handle.close()
    } else if (event.key === "Tab") {
      // One stop: the radio group.
      event.preventDefault()
    } else if (at !== -1 && ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
      event.preventDefault()
      const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : options.length - 1
      focusOption((at + step) % options.length)
    }
  }

  const handle: ColumnsPickerHandle = {
    element: dialog,
    close: ({ refocus = true } = {}) => {
      if (open !== handle) return
      open = null
      doc.removeEventListener("mousedown", onDocumentDown, true)
      editor.off("destroy", destroyed)
      dialog.remove()
      if (refocus && !editor.isDestroyed) editor.commands.focus()
    },
    pick: (index) => {
      const choice = COLUMNS_PICKER_LAYOUTS[index]
      handle.close({ refocus: false })
      // `editable` can change while the picker is open (a demotion, #313).
      if (editor.isDestroyed || !editor.isEditable || !choice) return
      editor.chain().focus().insertColumns({ count: choice.count, layout: choice.layout }).run()
    },
  }
  const destroyed = () => handle.close({ refocus: false })

  dialog.addEventListener("keydown", onKeyDown)
  doc.addEventListener("mousedown", onDocumentDown, true)
  editor.on("destroy", destroyed)

  doc.body.append(dialog)
  open = handle
  const focusFirst = () => {
    if (open !== handle || dialog.contains(doc.activeElement)) return
    focusOption(0)
  }
  focusFirst()
  // Again on the next frame: a `focus()` command run just before focuses the editor then.
  doc.defaultView?.requestAnimationFrame?.(focusFirst)
  return handle
}
