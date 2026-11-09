import type { Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection } from "@tiptap/pm/state"
import type { EditorView, NodeView } from "@tiptap/pm/view"
import {
  EMBED_PROVIDER_SPECS,
  embedFrameLabel,
  embedIconOf,
  embedPreviewFrame,
  embedProviderList,
  embedProviderOf,
  embedTargetOf,
  normalizeEmbedTitle,
  type EmbedProvider,
} from "@gl-admin/lib/blocks-spec"
import { currentAllowedEmbeds } from "@gl-admin/lib/editorSettings"
import { applyEmbedLink, EMBED_EDIT_EVENT, takeEmbedFieldFocus, type EmbedLinkError } from "../blocks/embedLinks"
import { button, mediaIcon } from "./MediaBlockViews"
import { refOfBlock } from "../utils/blockTree"

// The editor's view of an embed (#425; the canvas's "Editor · embeds, custom HTML" and
// "Errors & empty states"): plain DOM, from BlockNodeViews' plugin (the schema in
// EmbedBlock.ts has no DOM code, so the collab server builds it).
//
// A block shows one of three things:
// - **the link field** while it has no link, or the toolbar's Edit link asked for it, with
//   any error the link got;
// - **a placeholder** (provider, title, Load, "Loading connects to youtube.com"): nothing
//   from the other site loads until someone clicks Load, here as for readers. A provider the
//   site no longer allows says so instead of offering Load;
// - **the player**, after Load. That state is this view's alone: never in the doc, gone on a
//   reload, and no other user's editor loads anything.
//
// Changes are one transaction each from the user's own input; no appendTransaction (rule 7).

const PROMPTS: Record<EmbedProvider, { prompt: string; help: string; block: string }> = {
  youtube: { prompt: "Paste a YouTube link", help: "Paste the link from the address bar or the Share button.", block: "YouTube" },
  vimeo: { prompt: "Paste a Vimeo link", help: "Paste the link to the video page.", block: "Vimeo" },
  x: { prompt: "Paste a link to a post on X", help: "Use the post's own link, which ends in /status/ and a number.", block: "X" },
  codepen: { prompt: "Paste a CodePen link", help: "Paste the link to the pen.", block: "CodePen" },
  soundcloud: { prompt: "Paste a SoundCloud link", help: "Paste the link to the track or playlist.", block: "SoundCloud" },
  spotify: { prompt: "Paste a Spotify link", help: "Paste the link from Share › Copy link.", block: "Spotify" },
}

const NOT_ALLOWED_NOTE = "This site is no longer allowed, so readers don't see this embed. An admin can allow it in Settings › Editor."

function linkHelp(): string {
  const allowed = currentAllowedEmbeds()
  return allowed && allowed.length > 0 ? `Works with ${embedProviderList(allowed, "and")} links.` : "Paste a link to an item on an allowed site."
}

export class EmbedBlockView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private body: HTMLElement
  private addCaption: HTMLButtonElement
  private rendered = ""
  private editing = false
  private busy = false
  private error: EmbedLinkError | null = null
  private draft = ""
  /** The target the player was opened for (a changed link closes it). */
  private loaded: string | null = null

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private editor: Editor,
  ) {
    this.dom = document.createElement("figure")
    this.dom.className = "editor-media editor-embed"
    this.dom.dataset.type = "embed"
    this.body = document.createElement("div")
    this.body.className = "editor-media__body"
    this.body.contentEditable = "false"
    this.contentDOM = document.createElement("div")
    this.contentDOM.className = "editor-media__caption-slot"
    this.addCaption = button("Add caption", "editor-image__add-caption")
    this.addCaption.contentEditable = "false"
    this.addCaption.addEventListener("click", () => {
      if (!this.view.editable) return
      const pos = this.getPos()
      if (pos !== undefined) this.editor.chain().focus().setNodeSelection(pos).toggleEmbedCaption().run()
    })
    this.dom.append(this.body, this.contentDOM, this.addCaption)
    this.dom.addEventListener(EMBED_EDIT_EVENT, () => this.openField())

    // A click on the block (not on its controls) selects it, as a media block's does.
    this.body.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || (event.target as Element).closest("button, input, iframe")) return
      event.preventDefault()
      this.selectSelf()
    })

    this.render()
    if (!embedTargetOf(node.attrs) && this.view.editable && takeEmbedFieldFocus()) setTimeout(() => this.focusField(), 0)
  }

  private selectSelf() {
    const pos = this.getPos()
    if (pos === undefined) return
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
    this.view.focus()
  }

  private focusField() {
    this.body.querySelector("input")?.focus()
  }

  private openField() {
    if (!this.view.editable) return
    this.editing = true
    this.error = null
    const target = embedTargetOf(this.node.attrs)
    this.draft = target ? EMBED_PROVIDER_SPECS[target.provider].canonical(target.ref) : ""
    this.render(true)
    this.focusField()
  }

  private closeField() {
    this.editing = false
    this.error = null
    this.render(true)
  }

  private ref() {
    return refOfBlock({ node: this.node, pos: this.getPos() ?? -1 })
  }

  private async submit(raw: string) {
    if (this.busy || !this.view.editable) return
    this.draft = raw
    this.busy = true
    this.error = null
    this.render(true)
    // A block made for one provider keeps to it until it has a link; after that, Edit link
    // may move it to any allowed site ("Embed a link" blocks have no provider to keep).
    const expected = embedTargetOf(this.node.attrs) ? null : embedProviderOf(this.node.attrs)
    const failure = await applyEmbedLink(this.editor, this.ref(), raw, expected)
    this.busy = false
    this.error = failure
    if (!failure) {
      this.editing = false
      this.draft = ""
    }
    if (this.editor.isDestroyed) return
    // The answer can take seconds: leave the author where they went meanwhile.
    const active = document.activeElement
    const stayed = !active || active === document.body || this.dom.contains(active)
    this.render(true)
    if (!stayed) return
    if (failure) this.focusField()
    else this.selectSelf()
  }

  private remove() {
    const pos = this.getPos()
    if (pos === undefined || !this.view.editable) return
    this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize))
    this.view.focus()
  }

  private render(force = false) {
    const id = this.node.attrs["data-block-id"]
    if (typeof id === "string" && id) this.dom.setAttribute("data-block-id", id)
    else this.dom.removeAttribute("data-block-id")

    const editable = this.view.editable
    const target = embedTargetOf(this.node.attrs)
    const targetKey = target ? `${target.provider}:${target.ref}` : ""
    if (this.loaded && this.loaded !== targetKey) this.loaded = null
    const allowed = currentAllowedEmbeds()
    const blocked = !!target && !!allowed && !allowed.includes(target.provider)
    const title = normalizeEmbedTitle(this.node.attrs.title)
    const showField = (!target && editable) || (this.editing && editable)
    const state = showField ? "field" : !target ? "empty" : blocked ? "blocked" : this.loaded ? "loaded" : "placeholder"

    this.dom.dataset.state = state
    this.addCaption.hidden = this.node.childCount > 0 || !editable || !target
    // Only what the state shows: a title edit must not restart an open player or take the
    // focus out of the link field.
    const key = JSON.stringify(
      state === "field"
        ? [state, editable, this.node.attrs.provider, this.busy, this.error]
        : state === "loaded"
          ? [state, targetKey]
          : [state, editable, targetKey, title],
    )
    if (!force && key === this.rendered) return
    this.rendered = key
    this.body.replaceChildren()

    if (state === "field") return this.renderField(embedProviderOf(this.node.attrs), !!target)
    if (state === "empty") return this.renderEmpty()
    if (!target) return
    if (state === "loaded") return this.renderPlayer(target.provider, target.ref, title)
    this.renderPlaceholder(target.provider, title, blocked)
  }

  private renderEmpty() {
    const drop = document.createElement("div")
    drop.className = "editor-media__drop"
    const text = document.createElement("p")
    text.textContent = "No link yet."
    drop.append(text)
    this.body.append(drop)
  }

  private renderField(provider: EmbedProvider | null, hasLink: boolean) {
    const texts = provider ? PROMPTS[provider] : { prompt: "Paste a link", help: linkHelp(), block: "Embed a link" }
    const drop = document.createElement("div")
    drop.className = `editor-media__drop editor-embed__field${this.error ? " is-invalid" : ""}`

    const head = document.createElement("div")
    head.className = "editor-media__drop-head"
    head.append(mediaIcon(embedIconOf(provider), 16), texts.block)

    const input = document.createElement("input")
    input.type = "url"
    input.setAttribute("aria-label", texts.prompt)
    input.className = "editor-embed__input"
    input.placeholder = texts.prompt
    input.value = this.draft
    input.disabled = this.busy
    input.id = `embed-url-${Math.random().toString(36).slice(2, 10)}`
    input.addEventListener("input", () => {
      this.draft = input.value
    })
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        void this.submit(input.value)
      } else if (event.key === "Escape") {
        event.preventDefault()
        if (hasLink) this.closeField()
        this.selectSelf()
      }
    })

    const actions = document.createElement("div")
    actions.className = "editor-media__actions"
    const embed = button(this.busy ? "Checking…" : "Embed", "editor-media__button editor-embed__submit")
    embed.disabled = this.busy
    embed.addEventListener("click", () => void this.submit(input.value))
    actions.append(embed)
    if (hasLink) {
      const cancel = button("Cancel")
      cancel.addEventListener("click", () => this.closeField())
      actions.append(cancel)
    } else if (this.error) {
      const remove = button("Remove block", "editor-media__button editor-embed__remove")
      remove.addEventListener("click", () => this.remove())
      actions.append(remove)
    }

    drop.append(head, input)
    if (this.error) {
      const message = document.createElement("p")
      message.className = "editor-embed__error"
      message.id = `${input.id}-error`
      message.setAttribute("role", "alert")
      if (this.error.title) {
        const title = document.createElement("strong")
        title.textContent = this.error.title
        message.append(title, " ")
      }
      message.append(this.error.message)
      input.setAttribute("aria-invalid", "true")
      input.setAttribute("aria-describedby", message.id)
      drop.append(message)
    }
    drop.append(actions)
    if (!this.error) {
      const help = document.createElement("p")
      help.textContent = texts.help
      drop.append(help)
    }
    this.body.append(drop)
  }

  private renderPlaceholder(provider: EmbedProvider, title: string | null, blocked: boolean) {
    const spec = EMBED_PROVIDER_SPECS[provider]
    const facade = document.createElement("div")
    facade.className = `editor-embed__facade${spec.card ? " is-card" : ""}`

    const eyebrow = document.createElement("span")
    eyebrow.className = "editor-embed__provider"
    eyebrow.append(mediaIcon(embedIconOf(provider), 14), spec.kind)

    const heading = document.createElement("b")
    heading.className = "editor-embed__title"
    heading.textContent = title ?? spec.kind

    facade.append(eyebrow, heading)
    const note = document.createElement("small")
    note.className = "editor-embed__note"
    if (blocked) {
      note.textContent = NOT_ALLOWED_NOTE
      facade.append(note)
    } else {
      const load = button(spec.load)
      load.setAttribute("aria-label", `${spec.load}: ${title ?? spec.kind}`)
      load.addEventListener("click", () => this.load())
      note.textContent = `Loading connects to ${spec.host}`
      facade.append(load, note)
    }
    this.body.append(facade)
  }

  private load() {
    const target = embedTargetOf(this.node.attrs)
    if (!target) return
    this.loaded = `${target.provider}:${target.ref}`
    this.render(true)
    this.body.querySelector("iframe")?.focus()
  }

  private renderPlayer(provider: EmbedProvider, ref: string, title: string | null) {
    const spec = EMBED_PROVIDER_SPECS[provider]
    const frame = embedPreviewFrame(provider, ref)
    const box = document.createElement("div")
    box.className = `editor-embed__player${spec.card ? " is-card" : ""}${spec.compact ? " is-compact" : ""}`
    const iframe = document.createElement("iframe")
    iframe.title = embedFrameLabel(provider, title)
    iframe.setAttribute("loading", "lazy")
    iframe.setAttribute("referrerpolicy", frame.referrerPolicy)
    iframe.setAttribute("sandbox", frame.sandbox)
    if (frame.allow) iframe.setAttribute("allow", frame.allow)
    iframe.src = frame.src
    box.append(iframe)
    this.body.append(box)
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
    const target = event.target as globalThis.Node | null
    if (!target) return false
    if (this.contentDOM.contains(target)) return false
    if ((target as Element).closest?.("button, input, iframe")) return true
    if (this.addCaption.contains(target)) return true
    return event.type === "mousedown" && this.body.contains(target)
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    if (mutation.type === "selection") return false
    return !this.contentDOM.contains(mutation.target)
  }
}
