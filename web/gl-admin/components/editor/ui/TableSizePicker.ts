import type { Editor } from "@tiptap/core"
import { TABLE_MAX_COLUMNS, TABLE_MAX_ROWS } from "@gl-admin/lib/blocks-spec"
import { DEFAULT_TABLE_SIZE, TABLE_ICON } from "../extensions/TableBlock"

/**
 * The table's size picker (#420, the canvas's "Editor · table, …" board): a small dialog
 * at the caret with Columns and Rows (3 and 2 to start; Rows counts the header row) and
 * **Create table**, which inserts the table for the line the caret is on
 * (`insertTableBlock`) and puts the caret in its first cell. Esc, or a click outside,
 * closes it without inserting anything and puts focus back in the text.
 *
 * Plain DOM (no React), so the catalog entry can open it from any menu. One at a time.
 * Values outside 1..TABLE_MAX_COLUMNS / 1..TABLE_MAX_ROWS are clamped on Create; an empty
 * field takes its default.
 */
export interface TableSizePickerHandle {
  element: HTMLElement
  close: (options?: { refocus?: boolean }) => void
  /** Create the table with the fields' values (what the button and Enter do). */
  submit: () => void
}

let open: TableSizePickerHandle | null = null

/** The picker that is open, if any (tests). */
export function currentTableSizePicker(): TableSizePickerHandle | null {
  return open
}

/** "3", " 12 " → the number; anything else → the fallback. Clamped to 1..max. */
export function parseTableSize(value: string, max: number, fallback: number): number {
  const trimmed = value.trim()
  const n = /^\d+$/.test(trimmed) ? Number(trimmed) : fallback
  return Math.min(max, Math.max(1, n))
}

const SVG_NS = "http://www.w3.org/2000/svg"

function tableIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg")
  svg.setAttribute("width", "16")
  svg.setAttribute("height", "16")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("fill", "none")
  svg.setAttribute("stroke", "currentColor")
  svg.setAttribute("stroke-width", "1.75")
  svg.setAttribute("stroke-linecap", "round")
  svg.setAttribute("stroke-linejoin", "round")
  svg.setAttribute("aria-hidden", "true")
  const path = doc.createElementNS(SVG_NS, "path")
  path.setAttribute("d", TABLE_ICON)
  svg.append(path)
  return svg
}

let fieldCounter = 0

export function openTableSizePicker(editor: Editor): TableSizePickerHandle | null {
  open?.close({ refocus: false })
  if (!editor.isEditable) return null
  const doc = editor.view.dom.ownerDocument
  const previousFocus = doc.activeElement as HTMLElement | null

  const dialog = doc.createElement("div")
  dialog.className = "editor-table-picker"
  dialog.setAttribute("role", "dialog")
  dialog.setAttribute("aria-label", "Insert a table")

  const head = doc.createElement("div")
  head.className = "editor-table-picker__head"
  head.append(tableIcon(doc), doc.createTextNode("Table"))

  const form = doc.createElement("form")
  form.className = "editor-table-picker__form"
  form.noValidate = true

  const fields = doc.createElement("div")
  fields.className = "editor-table-picker__fields"
  const field = (label: string, value: number, max: number) => {
    const id = `gl-table-size-${++fieldCounter}`
    const wrap = doc.createElement("div")
    wrap.className = "editor-table-picker__field"
    const labelEl = doc.createElement("label")
    labelEl.htmlFor = id
    labelEl.textContent = label
    const input = doc.createElement("input")
    input.id = id
    input.type = "text"
    input.inputMode = "numeric"
    input.autocomplete = "off"
    input.value = String(value)
    input.setAttribute("aria-describedby", `${id}-hint`)
    const hint = doc.createElement("span")
    hint.id = `${id}-hint`
    hint.className = "editor-table-picker__hint"
    hint.textContent = `1 to ${max}`
    wrap.append(labelEl, input, hint)
    fields.append(wrap)
    return input
  }
  const cols = field("Columns", DEFAULT_TABLE_SIZE.cols, TABLE_MAX_COLUMNS)
  const rows = field("Rows", DEFAULT_TABLE_SIZE.rows, TABLE_MAX_ROWS)

  const actions = doc.createElement("div")
  actions.className = "editor-table-picker__actions"
  const create = doc.createElement("button")
  create.type = "submit"
  create.className = "editor-table-picker__create"
  create.textContent = "Create table"
  actions.append(create)

  form.append(fields, actions)
  dialog.append(head, form)

  // At the caret, below the line (fixed: the editor scrolls inside the page).
  try {
    const coords = editor.view.coordsAtPos(editor.state.selection.from)
    dialog.style.top = `${Math.round(coords.bottom + 6)}px`
    dialog.style.left = `${Math.round(coords.left)}px`
  } catch {
    // No layout (a headless test): the stylesheet's position applies.
  }

  const onDocumentDown = (event: MouseEvent) => {
    if (!dialog.contains(event.target as globalThis.Node)) handle.close()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      handle.close()
    } else if (event.key === "Tab") {
      // Keep focus in the dialog: the two fields and the button.
      const order: HTMLElement[] = [cols, rows, create]
      const at = order.indexOf(doc.activeElement as HTMLElement)
      if (at === -1) return
      event.preventDefault()
      order[(at + (event.shiftKey ? order.length - 1 : 1)) % order.length].focus()
    }
  }

  const handle: TableSizePickerHandle = {
    element: dialog,
    close: ({ refocus = true } = {}) => {
      if (open !== handle) return
      open = null
      doc.removeEventListener("mousedown", onDocumentDown, true)
      editor.off("destroy", destroyed)
      dialog.remove()
      if (refocus && !editor.isDestroyed) editor.commands.focus()
      else if (refocus) previousFocus?.focus?.()
    },
    submit: () => {
      const size = {
        cols: parseTableSize(cols.value, TABLE_MAX_COLUMNS, DEFAULT_TABLE_SIZE.cols),
        rows: parseTableSize(rows.value, TABLE_MAX_ROWS, DEFAULT_TABLE_SIZE.rows),
      }
      handle.close({ refocus: false })
      // `editable` can change while the picker is open (a demotion, #313).
      if (editor.isDestroyed || !editor.isEditable) return
      editor.chain().focus().insertTableBlock({ ...size, headerRow: true }).run()
    },
  }
  const destroyed = () => handle.close({ refocus: false })

  form.addEventListener("submit", (event) => {
    event.preventDefault()
    handle.submit()
  })
  dialog.addEventListener("keydown", onKeyDown)
  doc.addEventListener("mousedown", onDocumentDown, true)
  editor.on("destroy", destroyed)

  doc.body.append(dialog)
  open = handle
  const focusFirst = () => {
    if (open !== handle || dialog.contains(doc.activeElement)) return
    cols.focus()
    cols.select()
  }
  focusFirst()
  // Again on the next frame: a `focus()` command run just before (the slash menu closing,
  // a caller's chain) focuses the editor then, which would take focus from the dialog.
  doc.defaultView?.requestAnimationFrame?.(focusFirst)
  return handle
}
