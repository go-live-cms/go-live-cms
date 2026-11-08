import type { Editor } from "@tiptap/core"
import { DEFAULT_REMINDER_TIME, normalizeChipDate, normalizeChipTime } from "@gl-admin/lib/blocks-spec/inlineNodes"
import { loadedSiteDateSettings, loadSiteDateSettings } from "@gl-admin/lib/hooks/useSiteSettings"
import { zonedToUtc } from "@gl-admin/lib/schedule"
import { DEFAULT_DATE_SETTINGS, siteDay } from "@/lib/siteDates"

/**
 * The @ menu's "Date or reminder" (#320): a small dialog at the caret with a Date (today in
 * the site's zone to start), an optional Time, and **Remind me** ("You get an email then").
 * Insert puts a date chip at the caret (`insertDateChip`); a reminder always has a time
 * (09:00 when none is given), which must still be ahead in the site's time zone. Esc, or a
 * click outside, closes it without inserting anything and puts focus back in the text.
 *
 * Plain DOM, like the table's size picker (`TableSizePicker.ts`), so the menu can open it
 * after its own popup closes. One at a time.
 */
export interface DateChipDialogHandle {
  element: HTMLElement
  close: (options?: { refocus?: boolean }) => void
  /** Insert with the fields' values (the button and Enter). False when a field is wrong. */
  submit: () => boolean
  fields: { date: HTMLInputElement; time: HTMLInputElement; remind: HTMLInputElement }
}

export const DATE_DIALOG_ERRORS = {
  date: "Enter a date as YYYY-MM-DD.",
  time: "Enter a time as HH:MM, or leave it empty.",
  past: "That time has passed. Pick a later one for a reminder.",
}

export interface DateChipDialogValues {
  date: string
  time: string
  remind: boolean
}

/**
 * The chip the fields describe, or the error to show. `now` and the zone decide whether a
 * reminder is still ahead (the API refuses nothing: a past reminder simply never fires).
 */
export function dateChipFromFields(values: DateChipDialogValues, zone: string, now = new Date()):
  | { ok: true; attrs: { date: string; time: string | null; reminder: boolean } }
  | { ok: false; field: "date" | "time"; error: string } {
  const date = normalizeChipDate(values.date)
  if (!date) return { ok: false, field: "date", error: DATE_DIALOG_ERRORS.date }
  const typedTime = values.time.trim()
  const time = typedTime ? normalizeChipTime(typedTime) : null
  if (typedTime && !time) return { ok: false, field: "time", error: DATE_DIALOG_ERRORS.time }
  if (!values.remind) return { ok: true, attrs: { date, time, reminder: false } }
  const at = time ?? DEFAULT_REMINDER_TIME
  const instant = zonedToUtc(`${date}T${at}`, zone)
  if (!instant || instant.getTime() <= now.getTime()) return { ok: false, field: "time", error: DATE_DIALOG_ERRORS.past }
  return { ok: true, attrs: { date, time: at, reminder: true } }
}

let open: DateChipDialogHandle | null = null

/** The dialog that is open, if any (tests). */
export function currentDateChipDialog(): DateChipDialogHandle | null {
  return open
}

let fieldCounter = 0

export function openDateChipDialog(editor: Editor): DateChipDialogHandle | null {
  open?.close({ refocus: false })
  if (!editor.isEditable) return null
  const doc = editor.view.dom.ownerDocument
  let settings = loadedSiteDateSettings() ?? DEFAULT_DATE_SETTINGS

  const dialog = doc.createElement("div")
  dialog.className = "editor-table-picker editor-date-dialog"
  dialog.setAttribute("role", "dialog")
  dialog.setAttribute("aria-label", "Insert a date or reminder")

  const head = doc.createElement("div")
  head.className = "editor-table-picker__head"
  head.textContent = "Date or reminder"

  const form = doc.createElement("form")
  form.className = "editor-table-picker__form"
  form.noValidate = true

  const fields = doc.createElement("div")
  fields.className = "editor-table-picker__fields"
  const field = (label: string, type: string, value: string) => {
    const id = `gl-date-chip-${++fieldCounter}`
    const wrap = doc.createElement("div")
    wrap.className = "editor-table-picker__field"
    const labelEl = doc.createElement("label")
    labelEl.htmlFor = id
    labelEl.textContent = label
    const input = doc.createElement("input")
    input.id = id
    input.type = type
    input.autocomplete = "off"
    input.value = value
    wrap.append(labelEl, input)
    fields.append(wrap)
    return input
  }
  const initialDay = siteDay(new Date(), settings)
  const date = field("Date", "date", initialDay)
  const time = field("Time (optional)", "time", "")

  const remindWrap = doc.createElement("label")
  remindWrap.className = "editor-date-dialog__remind"
  const remind = doc.createElement("input")
  remind.type = "checkbox"
  const remindText = doc.createElement("span")
  remindText.textContent = "Remind me"
  const remindHint = doc.createElement("span")
  remindHint.className = "editor-table-picker__hint"
  remindHint.textContent = `You get an email then (${settings.timeZone}).`
  remindWrap.append(remind, remindText, remindHint)

  const error = doc.createElement("p")
  error.className = "editor-date-dialog__error"
  error.setAttribute("role", "alert")
  error.hidden = true

  const actions = doc.createElement("div")
  actions.className = "editor-table-picker__actions"
  const insert = doc.createElement("button")
  insert.type = "submit"
  insert.className = "editor-table-picker__create"
  insert.textContent = "Insert date"
  actions.append(insert)
  remind.addEventListener("change", () => {
    insert.textContent = remind.checked ? "Set reminder" : "Insert date"
    if (remind.checked && !time.value) time.value = DEFAULT_REMINDER_TIME
  })

  form.append(fields, remindWrap, error, actions)
  dialog.append(head, form)

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
      const order: HTMLElement[] = [date, time, remind, insert]
      const at = order.indexOf(doc.activeElement as HTMLElement)
      if (at === -1) return
      event.preventDefault()
      order[(at + (event.shiftKey ? order.length - 1 : 1)) % order.length].focus()
    }
  }

  const showError = (input: HTMLInputElement, message: string) => {
    error.textContent = message
    error.hidden = false
    input.setAttribute("aria-invalid", "true")
    input.focus()
  }

  const handle: DateChipDialogHandle = {
    element: dialog,
    fields: { date, time, remind },
    close: ({ refocus = true } = {}) => {
      if (open !== handle) return
      open = null
      doc.removeEventListener("mousedown", onDocumentDown, true)
      editor.off("destroy", destroyed)
      dialog.remove()
      if (refocus && !editor.isDestroyed) editor.commands.focus()
    },
    submit: () => {
      date.removeAttribute("aria-invalid")
      time.removeAttribute("aria-invalid")
      const result = dateChipFromFields({ date: date.value, time: time.value, remind: remind.checked }, settings.timeZone)
      if (!result.ok) {
        showError(result.field === "date" ? date : time, result.error)
        return false
      }
      handle.close({ refocus: false })
      // `editable` can change while the dialog is open (a demotion, #313).
      if (editor.isDestroyed || !editor.isEditable) return false
      // At the editor's selection, which ProseMirror kept mapped through collaborators' edits.
      return editor.chain().focus().insertDateChip(result.attrs).run()
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

  // Not loaded yet (the site's zone decides today and whether a reminder is ahead): load,
  // then move the untouched default day to the site's.
  if (!loadedSiteDateSettings()) {
    void loadSiteDateSettings().then((loaded) => {
      if (!loaded || open !== handle) return
      settings = loaded
      remindHint.textContent = `You get an email then (${loaded.timeZone}).`
      if (date.value === initialDay) date.value = siteDay(new Date(), loaded)
    })
  }

  doc.body.append(dialog)
  open = handle
  const focusFirst = () => {
    if (open !== handle || dialog.contains(doc.activeElement)) return
    date.focus()
  }
  focusFirst()
  // Again on the next frame: the menu's `focus()` just before would take focus back.
  doc.defaultView?.requestAnimationFrame?.(focusFirst)
  return handle
}
