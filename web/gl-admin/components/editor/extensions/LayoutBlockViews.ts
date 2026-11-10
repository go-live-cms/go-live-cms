import type { Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection } from "@tiptap/pm/state"
import type { EditorView, NodeView } from "@tiptap/pm/view"
import {
  buttonHrefFromInput,
  BUTTON_VARIANTS,
  BUTTONS_ALIGNS,
  columnsLayoutFor,
  COLUMNS_LAYOUT_LABELS,
  COLUMNS_MAX,
  COLUMNS_MIN,
  DEFAULT_BUTTON_VARIANT,
  GROUP_ALIGNS,
  isButtonsAlign,
  isButtonVariant,
  isGroupAlign,
  nearestSpacerSize,
  normalizeButtonHref,
  normalizeSpacerSize,
  spacerPx,
  stepSpacerSize,
  TWO_COLUMN_LAYOUTS,
  type ButtonsAlign,
  type ButtonVariant,
  type GroupAlign,
} from "@gl-admin/lib/blocks-spec"
import { setColumnCount } from "../utils/columnActions"
import { refOfBlock } from "../utils/blockTree"
import { currentButton } from "./ButtonsBlock"
import { setBlockId } from "./MediaBlockViews"

// The editor's views of the layout blocks (#426, the canvas's "Editor · columns, group,
// buttons, spacer"): columns (Columns, Layout, Width), buttons (Link, Style, Add button,
// alignment) and the spacer (its hatching and its handle). Editor only: the schema
// extensions stay DOM-free, so the collab server can build them. Every control is one
// ordinary transaction from the user's own input (no appendTransaction, rule 7).

const WIDTH_LABELS: Record<GroupAlign, string> = { content: "Content", wide: "Wide", full: "Full" }
const STYLE_LABELS: Record<ButtonVariant, string> = { primary: "Primary", secondary: "Secondary" }
const ALIGN_LABELS: Record<ButtonsAlign, string> = { left: "Left", center: "Centre" }

/** A labelled group of toggle buttons in a block's toolbar, the group's look. */
export function segment(doc: Document, label: string, block: string, options: { value: string; text: string; onClick: () => void }[]) {
  const field = doc.createElement("div")
  field.className = "editor-group__field"
  field.setAttribute("role", "group")
  field.setAttribute("aria-label", `${block} ${label.toLowerCase()}`)
  const name = doc.createElement("span")
  name.className = "editor-group__label"
  name.textContent = label
  name.setAttribute("aria-hidden", "true")
  field.append(name)
  const buttons = new Map<string, HTMLButtonElement>()
  for (const { value, text, onClick } of options) {
    const button = doc.createElement("button")
    button.type = "button"
    button.className = "editor-group__option"
    button.textContent = text
    button.dataset.value = value
    // Keep the cursor where it is.
    button.addEventListener("mousedown", (event) => event.preventDefault())
    button.addEventListener("click", onClick)
    buttons.set(value, button)
    field.append(button)
  }
  return { field, buttons }
}

/** ← → move between a toolbar's buttons, Esc goes back to the block in the text. */
export function toolbarKeys(toolbar: HTMLElement, onEscape: () => void) {
  toolbar.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement
    if (target.tagName === "INPUT") return
    const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button")).filter((button) => !button.closest("[hidden]"))
    const at = buttons.indexOf(target as HTMLButtonElement)
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault()
      buttons[(at + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length]?.focus()
    } else if (event.key === "Escape") {
      event.preventDefault()
      onEscape()
    }
  })
}

/** A selected block stays selected through a change of its own attributes. */
export function selectBlockAgain(view: EditorView, pos: number, name: string) {
  if (view.state.doc.nodeAt(pos)?.type.name === name) view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
  view.focus()
}

/**
 * Columns: the grid of `column`s, plus its toolbar while the cursor is in it (or it is
 * selected): **Columns** 2–4 (`setColumnCount`: a removed column's blocks move to the last
 * column that stays), **Layout** (with two columns) and **Width**.
 */
export class ColumnsView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private toolbar: HTMLElement
  private countButtons: Map<string, HTMLButtonElement>
  private layoutField: HTMLElement
  private layoutButtons: Map<string, HTMLButtonElement>
  private alignButtons: Map<string, HTMLButtonElement>

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private editor: Editor,
  ) {
    const doc = view.dom.ownerDocument
    this.dom = doc.createElement("div")
    this.dom.className = "editor-columns"
    this.dom.dataset.type = "columns"
    this.toolbar = doc.createElement("div")
    this.toolbar.className = "editor-columns__toolbar"
    this.toolbar.contentEditable = "false"
    this.toolbar.setAttribute("role", "toolbar")
    this.toolbar.setAttribute("aria-label", "Columns")
    this.toolbar.setAttribute("data-block-toolbar", "")

    const counts = Array.from({ length: COLUMNS_MAX - COLUMNS_MIN + 1 }, (_, index) => COLUMNS_MIN + index)
    const count = segment(
      doc,
      "Columns",
      "Columns",
      counts.map((value) => ({ value: String(value), text: String(value), onClick: () => this.setCount(value) })),
    )
    this.countButtons = count.buttons
    const layout = segment(
      doc,
      "Layout",
      "Columns",
      TWO_COLUMN_LAYOUTS.map((value) => ({ value, text: COLUMNS_LAYOUT_LABELS[value], onClick: () => this.setAttr("layout", value) })),
    )
    this.layoutField = layout.field
    this.layoutButtons = layout.buttons
    const align = segment(
      doc,
      "Width",
      "Columns",
      GROUP_ALIGNS.map((value) => ({ value, text: WIDTH_LABELS[value], onClick: () => this.setAttr("align", value) })),
    )
    this.alignButtons = align.buttons
    this.toolbar.append(count.field, layout.field, align.field)
    toolbarKeys(this.toolbar, () => {
      const pos = this.getPos()
      if (pos !== undefined) selectBlockAgain(this.view, pos, "columns")
    })

    this.contentDOM = doc.createElement("div")
    this.contentDOM.className = "editor-columns__content"
    this.dom.append(this.toolbar, this.contentDOM)
    this.render()
  }

  private setCount(count: number) {
    const pos = this.getPos()
    if (pos === undefined || !this.view.editable) return
    const node = this.view.state.doc.nodeAt(pos)
    if (node?.type.name === "columns") setColumnCount(this.editor, refOfBlock({ node, pos }), count)
  }

  private setAttr(attr: "layout" | "align", value: string) {
    // `editable` can change without an update (a demotion, #313).
    if (!this.view.editable) return
    const pos = this.getPos()
    const current = pos === undefined ? null : this.view.state.doc.nodeAt(pos)
    if (pos === undefined || !current || current.type.name !== "columns" || current.attrs[attr] === value) return
    const { state } = this.view
    const tr = state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, [attr]: value })
    if (state.selection instanceof NodeSelection && state.selection.from === pos) tr.setSelection(NodeSelection.create(tr.doc, pos))
    this.view.dispatch(tr)
  }

  private render() {
    const count = this.node.childCount
    const layout = columnsLayoutFor(this.node.attrs.layout, count)
    const align = isGroupAlign(this.node.attrs.align) ? this.node.attrs.align : "content"
    this.dom.dataset.layout = layout
    this.dom.dataset.align = align
    this.dom.style.setProperty("--columns", String(count))
    setBlockId(this.dom, this.node)
    for (const [value, button] of this.countButtons) button.setAttribute("aria-pressed", String(Number(value) === count))
    // Equal is 50 / 50 with two columns; with more, the splits don't apply.
    this.layoutField.hidden = count !== 2
    const shown = layout === "equal" ? "50-50" : layout
    for (const [value, button] of this.layoutButtons) button.setAttribute("aria-pressed", String(value === shown))
    for (const [value, button] of this.alignButtons) button.setAttribute("aria-pressed", String(value === align))
    // Not hidden here: `editable` changes without an update (#313); the editor's
    // `[contenteditable="false"]` style hides the toolbar, and each control checks.
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  stopEvent(event: Event) {
    const target = event.target as globalThis.Node | null
    return Boolean(target && this.toolbar.contains(target))
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    if (mutation.type === "selection") return false
    return !this.contentDOM.contains(mutation.target)
  }
}

const LINK_ICON = "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"
const PLUS_ICON = "M12 5v14M5 12h14"
const SVG_NS = "http://www.w3.org/2000/svg"

function strokeIcon(doc: Document, path: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg")
  for (const [name, value] of Object.entries({ width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
    svg.setAttribute(name, value)
  }
  const line = doc.createElementNS(SVG_NS, "path")
  line.setAttribute("d", path)
  svg.append(line)
  return svg
}

let linkFieldCounter = 0

/**
 * Buttons: the row of `button`s, plus its toolbar while the cursor is in it (or it is
 * selected): **Link** (a field under the toolbar, checked like a link: `buttonHrefFromInput`),
 * **Style**, **Add button** and the row's alignment. The toolbar acts on the button the
 * caret is in (`currentButton`).
 */
export class ButtonsView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private toolbar: HTMLElement
  private linkButton: HTMLButtonElement
  private styleButtons: Map<string, HTMLButtonElement>
  private alignButtons: Map<string, HTMLButtonElement>
  private linkPanel: { dom: HTMLElement; input: HTMLInputElement; error: HTMLElement } | null = null
  /** The position of the button the open Link field belongs to. */
  private linkFor: number | undefined

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private editor: Editor,
  ) {
    const doc = view.dom.ownerDocument
    this.dom = doc.createElement("div")
    this.dom.className = "editor-buttons"
    this.dom.dataset.type = "buttons"
    this.dom.setAttribute("data-collab-bounds", "")
    this.toolbar = doc.createElement("div")
    this.toolbar.className = "editor-buttons__toolbar"
    this.toolbar.contentEditable = "false"
    this.toolbar.setAttribute("role", "toolbar")
    this.toolbar.setAttribute("aria-label", "Button")
    this.toolbar.setAttribute("data-block-toolbar", "")

    this.linkButton = doc.createElement("button")
    this.linkButton.type = "button"
    this.linkButton.className = "editor-buttons__icon"
    this.linkButton.setAttribute("aria-label", "Link")
    this.linkButton.setAttribute("aria-expanded", "false")
    this.linkButton.append(strokeIcon(doc, LINK_ICON))
    this.linkButton.addEventListener("mousedown", (event) => event.preventDefault())
    this.linkButton.addEventListener("click", () => this.toggleLink())

    const style = segment(
      doc,
      "Style",
      "Button",
      BUTTON_VARIANTS.map((value) => ({ value, text: STYLE_LABELS[value], onClick: () => this.run(() => this.editor.commands.setButtonVariant(value)) })),
    )
    this.styleButtons = style.buttons

    const add = doc.createElement("button")
    add.type = "button"
    add.className = "editor-buttons__icon"
    add.setAttribute("aria-label", "Add button")
    add.append(strokeIcon(doc, PLUS_ICON))
    add.addEventListener("mousedown", (event) => event.preventDefault())
    add.addEventListener("click", () => this.run(() => this.editor.chain().focus().addButton().run()))

    const align = segment(
      doc,
      "Align",
      "Buttons",
      BUTTONS_ALIGNS.map((value) => ({ value, text: ALIGN_LABELS[value], onClick: () => this.run(() => this.editor.commands.setButtonsAlign(value)) })),
    )
    this.alignButtons = align.buttons
    this.toolbar.append(this.linkButton, style.field, add, align.field)
    toolbarKeys(this.toolbar, () => {
      this.closeLink()
      const pos = this.getPos()
      if (pos !== undefined) selectBlockAgain(this.view, pos, "buttons")
    })

    this.contentDOM = doc.createElement("div")
    this.contentDOM.className = "editor-buttons__content"
    this.dom.append(this.toolbar, this.contentDOM)
    this.render()
    this.editor.on("selectionUpdate", this.onSelection)
  }

  /** The toolbar shows the button the caret is in: moving between them changes no node. */
  private onSelection = () => {
    if (this.linkPanel && this.current()?.pos !== this.linkFor) this.closeLink()
    this.render()
  }

  private run(command: () => unknown) {
    // `editable` can change without an update (a demotion, #313).
    if (this.view.editable) command()
  }

  private current() {
    const pos = this.getPos()
    if (pos === undefined) return null
    const node = this.view.state.doc.nodeAt(pos)
    return node?.type.name === "buttons" ? currentButton(this.view.state, { pos, node }) : null
  }

  private toggleLink() {
    if (this.linkPanel) this.closeLink()
    else this.openLink()
  }

  private openLink() {
    if (!this.view.editable) return
    const doc = this.dom.ownerDocument
    const panel = doc.createElement("div")
    panel.className = "editor-buttons__link"
    const id = `gl-button-link-${++linkFieldCounter}`
    const label = doc.createElement("label")
    label.className = "sr-only"
    label.htmlFor = id
    label.textContent = "Link URL"
    const input = doc.createElement("input")
    input.id = id
    input.type = "text"
    input.autocomplete = "off"
    input.spellcheck = false
    input.placeholder = "https://… or /path"
    input.value = normalizeButtonHref(this.current()?.node.attrs.href) ?? ""
    const error = doc.createElement("p")
    error.className = "editor-buttons__link-error"
    error.setAttribute("role", "alert")
    error.hidden = true
    const remove = doc.createElement("button")
    remove.type = "button"
    remove.className = "editor-buttons__link-remove"
    remove.textContent = "Remove link"
    remove.addEventListener("mousedown", (event) => event.preventDefault())
    remove.addEventListener("click", () => {
      this.run(() => this.editor.commands.setButtonLink(null))
      this.closeLink()
      this.view.focus()
    })
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        if (this.applyLink()) {
          this.closeLink()
          this.view.focus()
        }
      } else if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        this.closeLink()
        this.view.focus()
      }
    })
    input.addEventListener("input", () => this.showError(null))
    panel.append(label, input, error, remove)
    this.toolbar.append(panel)
    this.linkPanel = { dom: panel, input, error }
    this.linkFor = this.current()?.pos
    this.linkButton.setAttribute("aria-expanded", "true")
    input.focus()
  }

  private closeLink() {
    if (!this.linkPanel) return
    this.linkPanel.dom.remove()
    this.linkPanel = null
    this.linkButton.setAttribute("aria-expanded", "false")
  }

  private showError(message: string | null) {
    if (!this.linkPanel) return
    this.linkPanel.error.textContent = message ?? ""
    this.linkPanel.error.hidden = message === null
    if (message === null) this.linkPanel.input.removeAttribute("aria-invalid")
    else this.linkPanel.input.setAttribute("aria-invalid", "true")
  }

  /** Applies the field's value. False (and says why) when it can't be used. */
  private applyLink(): boolean {
    if (!this.linkPanel || !this.view.editable) return false
    const result = buttonHrefFromInput(this.linkPanel.input.value)
    if ("error" in result) {
      this.showError(result.error)
      return false
    }
    this.editor.commands.setButtonLink(result.href)
    return true
  }

  private render() {
    const align = isButtonsAlign(this.node.attrs.align) ? this.node.attrs.align : "left"
    this.dom.dataset.align = align
    setBlockId(this.dom, this.node)
    for (const [value, button] of this.alignButtons) button.setAttribute("aria-pressed", String(value === align))
    const button = this.current()
    const variant = isButtonVariant(button?.node.attrs.variant) ? button!.node.attrs.variant : DEFAULT_BUTTON_VARIANT
    for (const [value, option] of this.styleButtons) option.setAttribute("aria-pressed", String(value === variant))
    this.linkButton.classList.toggle("is-active", Boolean(normalizeButtonHref(button?.node.attrs.href)))
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  stopEvent(event: Event) {
    const target = event.target as globalThis.Node | null
    return Boolean(target && this.toolbar.contains(target))
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    if (mutation.type === "selection") return false
    return !this.contentDOM.contains(mutation.target)
  }

  destroy() {
    this.editor.off("selectionUpdate", this.onSelection)
    this.closeLink()
  }
}

const handleLabel = (px: number) => `Spacer height: ${px} px. Up and down arrows change it`

/**
 * A spacer: its height from the theme's scale, hatched with its size while hovered or
 * selected (otherwise just space, as on the page), and a handle: ↑ ↓ one step (the canvas's
 * "Keyboard"), or drag it. Every change is one `setSpacerSize`, last writer wins.
 */
export class SpacerView implements NodeView {
  dom: HTMLElement
  private label: HTMLElement
  private handle: HTMLButtonElement
  private toolbar: HTMLElement

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private editor: Editor,
  ) {
    const doc = view.dom.ownerDocument
    this.dom = doc.createElement("div")
    this.dom.className = "editor-spacer"
    this.dom.dataset.type = "spacer"
    this.label = doc.createElement("span")
    this.label.className = "editor-spacer__label"
    this.label.contentEditable = "false"
    this.label.setAttribute("aria-hidden", "true")
    // Tab from the drag handle lands here (#417), the handle being the spacer's one control.
    this.toolbar = doc.createElement("div")
    this.toolbar.className = "editor-spacer__toolbar"
    this.toolbar.contentEditable = "false"
    this.toolbar.setAttribute("data-block-toolbar", "")
    this.handle = doc.createElement("button")
    this.handle.type = "button"
    this.handle.className = "editor-spacer__handle"
    this.handle.addEventListener("keydown", (event) => this.onKey(event))
    this.handle.addEventListener("pointerdown", (event) => this.startDrag(event))
    this.toolbar.append(this.handle)
    this.dom.append(this.label, this.toolbar)
    this.render()
  }

  private setSize(size: string) {
    // `editable` can change without an update (a demotion, #313).
    const pos = this.getPos()
    if (pos === undefined || !this.view.editable) return
    this.editor.commands.setSpacerSize(pos, size as Parameters<typeof this.editor.commands.setSpacerSize>[1])
  }

  private onKey(event: KeyboardEvent) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault()
      event.stopPropagation()
      this.setSize(stepSpacerSize(this.node.attrs.size, event.key === "ArrowUp" ? 1 : -1))
    } else if (event.key === "Escape") {
      event.preventDefault()
      const pos = this.getPos()
      if (pos !== undefined) selectBlockAgain(this.view, pos, "spacer")
    }
  }

  private startDrag(event: PointerEvent) {
    if (!this.view.editable) return
    event.preventDefault()
    const startY = event.clientY
    const startPx = spacerPx(this.node.attrs.size)
    const doc = this.dom.ownerDocument
    const move = (moved: PointerEvent) => this.setSize(nearestSpacerSize(startPx + moved.clientY - startY))
    const up = () => {
      doc.removeEventListener("pointermove", move)
      doc.removeEventListener("pointerup", up)
    }
    doc.addEventListener("pointermove", move)
    doc.addEventListener("pointerup", up)
  }

  private render() {
    const px = spacerPx(this.node.attrs.size)
    this.dom.dataset.size = normalizeSpacerSize(this.node.attrs.size)
    this.dom.style.height = `${px}px`
    setBlockId(this.dom, this.node)
    this.label.textContent = `${px} px`
    this.handle.setAttribute("aria-label", handleLabel(px))
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  stopEvent(event: Event) {
    const target = event.target as globalThis.Node | null
    return Boolean(target && this.toolbar.contains(target))
  }

  ignoreMutation() {
    return true
  }
}
