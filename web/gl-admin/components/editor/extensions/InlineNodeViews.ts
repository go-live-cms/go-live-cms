import { Extension } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import type { NodeView } from "@tiptap/pm/view"
import { CONTENT_LINK_NODE, DATE_CHIP_NODE, dateChipAttrs, MENTION_NODE, normalizeEntityId } from "@gl-admin/lib/blocks-spec/inlineNodes"
import { mentionName, requestMentionName, subscribeMentionNames } from "@gl-admin/lib/mentionNames"
import { loadedSiteDateSettings, loadSiteDateSettings } from "@gl-admin/lib/hooks/useSiteSettings"
import { formatDateChip } from "@/lib/dateChips"
import { DEFAULT_DATE_SETTINGS } from "@/lib/siteDates"

/**
 * The editor's views of the #320 inline nodes (`InlineNodes.ts` is their schema): a
 * mention shows the member's **current** name (`lib/mentionNames.ts`; the stored label
 * until it is known, and "former member" styling for someone removed), a date chip the
 * site's language and date format plus a bell for a reminder, a content link its text
 * with a link icon. Views only: they change nothing in the doc and add no
 * appendTransaction (rule 7 doesn't apply). The DOM is the schema's `renderHTML` shape
 * (same `data-*` attributes), so copying from the editor gives the same HTML.
 */

const inlineNodeViewsKey = new PluginKey("inlineNodeViews")

/** Shown for a mention of a member who was removed since. */
export const FORMER_MEMBER_LABEL = "Former member"

class MentionView implements NodeView {
  dom: HTMLElement
  private node: PMNode
  private unsubscribe: () => void

  constructor(node: PMNode, doc: Document) {
    this.node = node
    this.dom = doc.createElement("span")
    this.dom.className = "editor-mention"
    this.dom.setAttribute("data-type", "mention")
    this.dom.contentEditable = "false"
    this.unsubscribe = subscribeMentionNames(() => this.render())
    this.render()
  }

  private render() {
    const id = normalizeEntityId(this.node.attrs.userId)
    const label = this.node.attrs.label as string | null
    if (id !== null) {
      this.dom.setAttribute("data-user-id", String(id))
      requestMentionName(id)
    }
    if (label) this.dom.setAttribute("data-label", label)
    else this.dom.removeAttribute("data-label")
    const name = id === null ? null : mentionName(id)
    const missing = name === null
    this.dom.classList.toggle("is-missing", missing)
    this.dom.textContent = `@${name ?? label ?? "member"}`
    if (missing) this.dom.title = FORMER_MEMBER_LABEL
    else this.dom.removeAttribute("title")
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  ignoreMutation() {
    return true
  }

  destroy() {
    this.unsubscribe()
  }
}

const SVG_NS = "http://www.w3.org/2000/svg"
const BELL_PATH = "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"
const LINK_PATH = "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6"

function icon(doc: Document, d: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg")
  for (const [name, value] of Object.entries({
    width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(name, value)
  const path = doc.createElementNS(SVG_NS, "path")
  path.setAttribute("d", d)
  svg.append(path)
  return svg
}

class DateChipView implements NodeView {
  dom: HTMLElement
  private node: PMNode
  private live = true

  constructor(node: PMNode, doc: Document) {
    this.node = node
    this.dom = doc.createElement("span")
    this.dom.className = "editor-date-chip"
    this.dom.setAttribute("data-type", "date")
    this.dom.contentEditable = "false"
    this.render()
    if (!loadedSiteDateSettings()) void loadSiteDateSettings().then(() => this.live && this.render())
  }

  private render() {
    const attrs = dateChipAttrs(this.node.attrs)
    const doc = this.dom.ownerDocument
    this.dom.replaceChildren()
    for (const name of ["data-date", "data-time", "data-reminder"]) this.dom.removeAttribute(name)
    this.dom.classList.toggle("is-reminder", !!attrs?.reminder)
    if (!attrs) return
    this.dom.setAttribute("data-date", attrs.date)
    if (attrs.time) this.dom.setAttribute("data-time", attrs.time)
    const text = formatDateChip(attrs, loadedSiteDateSettings() ?? DEFAULT_DATE_SETTINGS)
    if (attrs.reminder) {
      this.dom.setAttribute("data-reminder", "true")
      this.dom.append(icon(doc, BELL_PATH))
      // Emailed to whoever set it (the API's attribution), at that time in the site's zone.
      this.dom.title = `Reminder · ${text}`
    } else {
      this.dom.removeAttribute("title")
    }
    this.dom.append(doc.createTextNode(text))
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  ignoreMutation() {
    return true
  }

  destroy() {
    this.live = false
  }
}

class ContentLinkView implements NodeView {
  dom: HTMLElement
  private node: PMNode

  constructor(node: PMNode, doc: Document) {
    this.node = node
    this.dom = doc.createElement("span")
    this.dom.className = "editor-content-link"
    this.dom.setAttribute("data-type", "content-link")
    this.dom.contentEditable = "false"
    this.render()
  }

  private render() {
    const id = normalizeEntityId(this.node.attrs.postId)
    const label = (this.node.attrs.label as string | null) ?? "Untitled"
    if (id !== null) this.dom.setAttribute("data-post-id", String(id))
    this.dom.setAttribute("data-label", label)
    this.dom.replaceChildren(icon(this.dom.ownerDocument, LINK_PATH), this.dom.ownerDocument.createTextNode(label))
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  ignoreMutation() {
    return true
  }
}

export const InlineNodeViews = Extension.create({
  name: "inlineNodeViews",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: inlineNodeViewsKey,
        props: {
          nodeViews: {
            [MENTION_NODE]: (node, view) => new MentionView(node, view.dom.ownerDocument),
            [DATE_CHIP_NODE]: (node, view) => new DateChipView(node, view.dom.ownerDocument),
            [CONTENT_LINK_NODE]: (node, view) => new ContentLinkView(node, view.dom.ownerDocument),
          },
        },
      }),
    ]
  },
})
