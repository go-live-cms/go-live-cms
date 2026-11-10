import type { Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection } from "@tiptap/pm/state"
import type { EditorView, NodeView } from "@tiptap/pm/view"
import DOMPurify from "dompurify"
import { HTML_LOCKED_NOTE } from "@gl-admin/lib/blocks-spec"
import { authManager } from "@gl-admin/lib/auth"
import { isSiteAdmin } from "@gl-admin/lib/roles"
import type { PostHtmlSnippetsStore } from "@gl-admin/lib/htmlSnippetsStore"
import { HTML_MODE_EVENT, htmlSnippetsOf, onHtmlSnippetsChanged, takeHtmlFieldFocus, type HtmlBlockMode } from "../blocks/htmlSnippets"
import { snippetIdOf } from "./HtmlBlock"
import { refOfBlock, resolveEditorBlock } from "../utils/blockTree"
import { button, mediaIcon } from "./MediaBlockViews"

// The editor's view of a custom HTML block (#428; the canvas's "Editor · embeds, custom
// HTML"): plain DOM, from BlockNodeViews' plugin (the schema in HtmlBlock.ts has no DOM code,
// so the collab server builds it).
//
// - **An admin** gets an HTML / Preview switch and a code field. What they type is saved
//   through the admin-only API, debounced; the first save makes the snippet and puts its id
//   on the block, one transaction. Preview shows what the server kept, never the field.
// - **Everyone else** gets the locked preview: the markup, "Only admins can edit this block",
//   no field. The block stays a block, so they can still move or delete it. Being read-only
//   here is a courtesy: the server refuses their writes.
//
// The markup comes from the API, which sanitized it, and goes through DOMPurify too: this
// is the admin's own origin, and a preview is no place to find out the server was wrong.
//
// No appendTransaction: the one transaction is from the admin's own input (rule 7).

const SAVE_DELAY_MS = 800
const INDENT = "  "

const LOCK_ICON = "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4"

const isAdmin = () => isSiteAdmin(authManager.getState().user?.role)

export class HtmlBlockView implements NodeView {
  dom: HTMLElement
  private body: HTMLElement
  private field: HTMLTextAreaElement | null = null
  private message: HTMLElement | null = null
  private store: PostHtmlSnippetsStore | null = null
  private unsubscribe: (() => void) | null = null
  private offStore: () => void
  private mode: HtmlBlockMode
  private draft = ""
  private dirty = false
  private failed = false
  private saving: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** After Esc, Tab leaves the field instead of indenting. */
  private escaped = false
  private rendered = ""
  /** Just made from a menu: the field takes the cursor as soon as it can be typed in. */
  private wantFocus = false

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private editor: Editor,
  ) {
    this.dom = document.createElement("div")
    this.dom.className = "editor-media editor-html"
    this.dom.dataset.type = "html"
    this.body = document.createElement("div")
    this.body.className = "editor-html__body"
    this.body.contentEditable = "false"
    this.dom.append(this.body)

    this.mode = "html"
    this.dom.addEventListener(HTML_MODE_EVENT, (event) => this.setMode((event as CustomEvent<HtmlBlockMode>).detail))
    this.body.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || (event.target as Element).closest("button, textarea, a")) return
      event.preventDefault()
      this.selectSelf()
    })
    // A link in a preview is markup to look at: it must not navigate away from the editor.
    this.body.addEventListener("click", (event) => {
      if ((event.target as Element).closest(".editor-html__preview")) event.preventDefault()
    })

    this.offStore = onHtmlSnippetsChanged(editor, () => this.bindStore())
    this.wantFocus = takeHtmlFieldFocus()
    this.bindStore()
  }

  private snippetId(): string | null {
    return snippetIdOf(this.node.attrs)
  }

  private canEdit(): boolean {
    return this.view.editable && isAdmin() && !!this.store
  }

  private bindStore() {
    const store = htmlSnippetsOf(this.editor)
    if (store === this.store) {
      this.render()
      return
    }
    this.unsubscribe?.()
    this.store = store
    this.unsubscribe = store ? store.subscribe(() => this.render()) : null
    store?.ensureLoaded()
    this.render()
  }

  private selectSelf() {
    const pos = this.getPos()
    if (pos === undefined) return
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
    this.view.focus()
  }

  private setMode(mode: HtmlBlockMode) {
    if (mode === this.mode) return
    if (mode === "preview") void this.commit()
    this.mode = mode
    this.render(true)
    if (mode === "html") this.field?.focus()
  }

  private scheduleSave() {
    if (this.timer) clearTimeout(this.timer)
    this.store?.track(this.flushForPublish)
    this.timer = setTimeout(() => void this.commit(), SAVE_DELAY_MS)
  }

  /** Sends the field's text if it changed; another save starts when one is already running. */
  private commit = (): Promise<void> => {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.store || !this.dirty) return this.saving ?? Promise.resolve()
    if (this.saving) return this.saving
    const store = this.store
    const run = async () => {
      while (this.dirty) {
        this.dirty = false
        try {
          const id = await store.save(this.snippetId(), this.draft)
          this.failed = false
          if (id !== this.snippetId()) this.setSnippetId(id)
        } catch {
          this.failed = true
          this.dirty = true
          break
        }
      }
    }
    this.saving = run().finally(() => {
      this.saving = null
      if (!this.dirty) store.untrack(this.flushForPublish)
      this.showFailure()
    })
    return this.saving
  }

  /** What Publish waits for: refuses when this block's text couldn't be saved. */
  private flushForPublish = async (): Promise<void> => {
    await this.commit()
    if (this.failed) throw new Error("A custom HTML block couldn't be saved, so nothing was published. Try again.")
  }

  private showFailure() {
    if (!this.message) return
    this.message.hidden = !this.failed
    this.message.textContent = this.failed ? "Couldn't save this HTML. Edit it again to retry." : ""
  }

  /** The block found by its id when the answer arrives: positions move, ids don't. */
  private setSnippetId(id: string) {
    if (this.editor.isDestroyed || !this.editor.isEditable) return
    const block = resolveEditorBlock(this.editor.state.doc, refOfBlock({ node: this.node, pos: this.getPos() ?? -1 }))
    if (!block || block.node.type.name !== "html") return
    this.view.dispatch(this.editor.state.tr.setNodeMarkup(block.pos, undefined, { ...block.node.attrs, snippetId: id }))
  }

  private render(force = false) {
    const id = this.node.attrs["data-block-id"]
    if (typeof id === "string" && id) this.dom.setAttribute("data-block-id", id)
    else this.dom.removeAttribute("data-block-id")

    const store = this.store
    const snippetId = this.snippetId()
    if (store && snippetId) store.requestUnknown(snippetId)
    const markup = store?.get(snippetId) ?? ""
    const canEdit = this.canEdit()
    // An admin in a post that isn't saved yet: the snippet needs a post to belong to.
    const unsaved = !store && this.view.editable && isAdmin()
    const state = canEdit ? this.mode : unsaved ? "unsaved" : "locked"
    this.dom.dataset.mode = state

    const key = JSON.stringify([state, !!store, store?.loaded, store?.failed, snippetId, state === "html" ? "" : markup])
    if (!force && key === this.rendered) {
      // Another admin's save reaches a field nobody is typing in.
      if (state === "html" && this.field && !this.dirty && !this.saving && document.activeElement !== this.field && this.field.value !== markup) {
        this.field.value = markup
        this.draft = markup
      }
      return
    }
    this.rendered = key
    const hadFocus = !!this.field && document.activeElement === this.field
    this.body.replaceChildren()
    this.field = null
    this.message = null

    if (state === "locked") return this.renderLocked(markup)
    if (state === "unsaved") {
      const note = document.createElement("p")
      note.className = "editor-html__empty"
      note.textContent = "Save the post to write its HTML."
      this.body.append(note)
      return
    }
    this.renderBar()
    if (state === "html") this.renderField(markup, hadFocus)
    else this.body.append(this.preview(markup))
  }

  private renderLocked(markup: string) {
    const bar = document.createElement("div")
    bar.className = "editor-html__bar"
    const pill = document.createElement("span")
    pill.className = "editor-html__pill"
    pill.append(mediaIcon(LOCK_ICON, 11), "Custom HTML")
    const note = document.createElement("span")
    note.className = "editor-html__note"
    note.textContent = HTML_LOCKED_NOTE
    bar.append(pill, note)
    this.body.append(bar, this.preview(markup))
  }

  private renderBar() {
    const bar = document.createElement("div")
    bar.className = "editor-html__bar"
    const group = document.createElement("div")
    group.className = "editor-html__seg"
    group.setAttribute("role", "radiogroup")
    group.setAttribute("aria-label", "View")
    for (const [mode, label] of [["html", "HTML"], ["preview", "Preview"]] as const) {
      const option = button(label)
      option.setAttribute("role", "radio")
      option.setAttribute("aria-checked", String(this.mode === mode))
      option.addEventListener("click", () => this.setMode(mode))
      group.append(option)
    }
    bar.append(group)
    this.body.append(bar)
  }

  private renderField(markup: string, focus: boolean) {
    const store = this.store
    const ready = !!store?.loaded
    const field = document.createElement("textarea")
    field.className = "editor-html__code"
    field.setAttribute("aria-label", "HTML")
    field.spellcheck = false
    field.autocapitalize = "off"
    field.placeholder = "Write HTML"
    field.rows = 6
    // Not before the post's snippets are read: a save would overwrite markup it never saw.
    field.disabled = !ready
    // Not over text still on its way to the server: the store has the old markup until then.
    if (!this.dirty && !this.saving) this.draft = markup
    field.value = this.draft
    field.addEventListener("input", () => {
      this.draft = field.value
      this.dirty = true
      this.escaped = false
      this.scheduleSave()
    })
    field.addEventListener("keydown", (event) => this.onFieldKey(event, field))
    field.addEventListener("blur", () => void this.commit())
    this.field = field
    this.message = document.createElement("p")
    this.message.className = "editor-html__error"
    this.message.setAttribute("role", "alert")
    this.message.hidden = true
    this.body.append(field, this.message)
    if (store?.failed) {
      this.message.hidden = false
      this.message.textContent = "Couldn't load this post's HTML. Reload the page to try again."
    } else {
      this.showFailure()
    }
    if (!ready) return
    if (focus) field.focus()
    else if (this.wantFocus) {
      this.wantFocus = false
      // A frame later: TipTap's own focus after an insert would take it back.
      setTimeout(() => field.focus(), 0)
    }
  }

  // Tab indents (⇧Tab outdents the line); Esc, then Tab leaves the field, as the canvas's
  // keyboard board says, since a code field that traps Tab must offer a way out.
  private onFieldKey(event: KeyboardEvent, field: HTMLTextAreaElement) {
    if (event.key === "Escape") {
      this.escaped = true
      return
    }
    if (event.key !== "Tab" || this.escaped) {
      if (event.key !== "Tab") this.escaped = false
      return
    }
    event.preventDefault()
    if (event.shiftKey) this.outdent(field)
    else field.setRangeText(INDENT, field.selectionStart, field.selectionEnd, "end")
    this.draft = field.value
    this.dirty = true
    this.scheduleSave()
  }

  private outdent(field: HTMLTextAreaElement) {
    const start = field.value.lastIndexOf("\n", field.selectionStart - 1) + 1
    const removed = field.value.startsWith(INDENT, start) ? INDENT.length : field.value[start] === " " ? 1 : 0
    if (removed === 0) return
    const caret = field.selectionStart
    field.setRangeText("", start, start + removed, "preserve")
    field.setSelectionRange(Math.max(start, caret - removed), Math.max(start, caret - removed))
  }

  private preview(markup: string): HTMLElement {
    const preview = document.createElement("div")
    preview.className = "editor-html__preview"
    if (markup) {
      preview.innerHTML = DOMPurify.sanitize(markup)
      return preview
    }
    // Empty, or not known yet: the line says which, never an empty box.
    const empty = document.createElement("p")
    empty.className = "editor-html__empty"
    empty.textContent = this.store?.failed ? "Couldn't load this block's HTML." : this.store && !this.store.loaded ? "Loading…" : "No HTML yet."
    preview.append(empty)
    return preview
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  selectNode() {
    this.dom.classList.add("ProseMirror-selectednode")
  }

  deselectNode() {
    this.dom.classList.remove("ProseMirror-selectednode")
  }

  stopEvent(event: Event) {
    const target = event.target as Element | null
    if (!target?.closest) return false
    if (target.closest("button, textarea, a")) return true
    return event.type === "mousedown" && this.body.contains(target)
  }

  ignoreMutation() {
    return true
  }

  destroy() {
    this.offStore()
    this.unsubscribe?.()
    // The block can be moved while a save waits: a new view takes over, the text goes out.
    if (this.dirty) void this.commit()
    else this.store?.untrack(this.flushForPublish)
  }
}
