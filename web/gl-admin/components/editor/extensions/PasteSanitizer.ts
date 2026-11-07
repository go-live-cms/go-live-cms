import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "prosemirror-state"
import DOMPurify from "dompurify"
import {
  clampTableSpan,
  CONTAINER_NODE_NAMES,
  isCalloutTone,
  isGroupAlign,
  isGroupStyle,
  normalizeBlockColor,
  normalizeCite,
} from "@gl-admin/lib/blocks-spec"

const pasteSanitizerPluginKey = new PluginKey("pasteSanitizer")

/**
 * Paste: sanitize, then let the editor schema convert to blocks (#128).
 *
 * Pasted HTML (Google Docs, Word, web pages, another editor) goes through
 * `sanitizePastedHTML` before ProseMirror parses it. The schema's parse rules then
 * turn what's left into the block node types we support; anything they don't match
 * is unwrapped to its text. Nothing pasted is ever stored as raw HTML.
 *
 * Collab: this only implements `transformPastedHTML`, which runs for local pastes
 * only. It has no appendTransaction/filterTransaction, so rule 7 (ignore
 * collaboration-sync transactions) doesn't apply. Block ids for the pasted nodes come
 * from BlockIdExtension's appendTransaction on the paste transaction, as for typing.
 */

// Tags that survive. Formatting maps to marks (strong/em/u/s/code/a); the structural
// block tags that have no node of their own (div, table, …) are kept so ProseMirror
// still breaks paragraphs at their boundaries instead of running cells/divs together.
// Every other element (span, font, o:p, img, …) is unwrapped: removed, text kept.
const ALLOWED_TAGS = [
  "p", "br", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "pre", "code", "hr",
  "a", "strong", "b", "em", "i", "u", "s", "strike", "del",
  "div", "section", "article", "header", "footer", "aside", "main", "address", "hgroup",
  "figure", "figcaption", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
]

// Elements removed together with their content. DOMPurify's default list, minus
// `thead` (header cells are real text), plus form controls and embeds.
const FORBID_CONTENTS = [
  "annotation-xml", "audio", "colgroup", "desc", "foreignobject", "head", "iframe",
  "math", "mi", "mn", "mo", "ms", "mtext", "noembed", "noframes", "noscript",
  "plaintext", "script", "style", "svg", "template", "title", "video", "xmp",
  "object", "embed", "canvas", "button", "select", "textarea",
]

// http(s), mailto, tel and relative URLs. Any other scheme (javascript:, data:,
// vbscript:, file:, …) is stripped, matching the server's href allowlist (#188).
// DOMPurify removes whitespace/control characters before testing, so `java\tscript:`
// doesn't slip through. Only `href` is a URI attribute here (images are dropped).
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

const CODE_LANGUAGE_CLASS = /(?:^|\s)(language-[\w-]+)(?:\s|$)/

// Block colour (#356): the editor's own clipboard carries `data-block-color` on the blocks
// that take one (BlockColor.ts). Kept only there and only with a palette token: any other
// value, any other element, and every inline `color`/`background` style (stripped with
// the style attribute) is dropped, so a paste can never bring in a free colour.
const BLOCK_COLOR_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "UL", "OL"])

// Containers (#414): the editor's own clipboard renders a group as
// `<div data-type="group" data-style data-align>` (GroupBlock.ts). Kept only on a <div>,
// only that type and only valid values, so a pasted group is a group again (with fresh
// ids: `data-block-id` is never kept) and no other markup can claim to be one.
const CONTAINER_DIV_TYPES = new Set(["group"])
const isGroupDiv = (node: Element) => node.nodeName === "DIV" && node.getAttribute("data-type") === "group"

// The #419 blocks, from the editor's own clipboard: a callout `<div data-type="callout"
// data-tone>` (Callout.ts), a pull quote `<figure data-type="pull-quote" data-cite>`
// (PullQuote.ts) and a to-do list `<ul data-type="taskList"><li data-type="taskItem"
// data-checked>` (TipTap's TaskList/TaskItem; its checkbox `<input>` is unwrapped like any
// form control). Each `data-type` only on its own element, each value checked, so no other
// markup can claim to be one, and an unknown tone or a citation over the cap never gets in.
const BLOCK_DATA_TYPES: Readonly<Record<string, ReadonlySet<string>>> = {
  DIV: new Set([...CONTAINER_DIV_TYPES, "callout"]),
  FIGURE: new Set(["pull-quote"]),
  UL: new Set(["taskList"]),
  LI: new Set(["taskItem"]),
}
const isTyped = (node: Element, tag: string, type: string) => node.nodeName === tag && node.getAttribute("data-type") === type

let purifier: ReturnType<typeof DOMPurify> | null = null

// A private DOMPurify instance, so our hooks and config don't leak into any other caller.
function getPurifier() {
  if (purifier) return purifier
  purifier = DOMPurify(window)
  purifier.setConfig({
    ALLOWED_TAGS,
    ALLOWED_ATTR: [
      "href", "class", "data-pm-slice", "data-block-color", "data-type", "data-style", "data-align",
      "data-tone", "data-cite", "data-checked", "colspan", "rowspan",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP,
    FORBID_CONTENTS,
    KEEP_CONTENT: true,
  })
  purifier.addHook("uponSanitizeAttribute", (node, data) => {
    if (data.attrName === "class") {
      // Keep only `language-*` on <code>: CodeBlockLowlight reads the language from it.
      const match = node.nodeName === "CODE" ? CODE_LANGUAGE_CLASS.exec(data.attrValue) : null
      if (match) data.attrValue = match[1]
      else data.keepAttr = false
    } else if (data.attrName === "data-block-color") {
      const color = BLOCK_COLOR_TAGS.has(node.nodeName) ? normalizeBlockColor(data.attrValue) : null
      if (color === null) data.keepAttr = false
      else data.attrValue = color
    } else if (data.attrName === "data-type") {
      if (!BLOCK_DATA_TYPES[node.nodeName]?.has(data.attrValue)) data.keepAttr = false
    } else if (data.attrName === "data-tone") {
      if (!isTyped(node, "DIV", "callout") || !isCalloutTone(data.attrValue)) data.keepAttr = false
    } else if (data.attrName === "data-cite") {
      const cite = isTyped(node, "FIGURE", "pull-quote") ? normalizeCite(data.attrValue) : null
      if (cite === null) data.keepAttr = false
      else data.attrValue = cite
    } else if (data.attrName === "data-checked") {
      if (!isTyped(node, "LI", "taskItem") || (data.attrValue !== "true" && data.attrValue !== "false")) data.keepAttr = false
    } else if (data.attrName === "data-style") {
      if (!isGroupDiv(node) || !isGroupStyle(data.attrValue)) data.keepAttr = false
    } else if (data.attrName === "data-align") {
      if (!isGroupDiv(node) || !isGroupAlign(data.attrValue)) data.keepAttr = false
    } else if (data.attrName === "colspan" || data.attrName === "rowspan") {
      // A cell's span (#420), on a cell only, as the integer Block Spec stores (1..TABLE_MAX_SPAN).
      const span = node.nodeName === "TD" || node.nodeName === "TH" ? clampTableSpan(data.attrValue) : 1
      if (span === 1) data.keepAttr = false
      else data.attrValue = String(span)
    } else if (data.attrName === "data-pm-slice") {
      const value = sanitizeSliceContext(data.attrValue)
      if (value === null) data.keepAttr = false
      else data.attrValue = value
    }
  })
  return purifier
}

/**
 * Sanitizes clipboard HTML for the editor. Pure string → string (needs a DOM).
 *
 * Images are dropped (decision on #128): remote ones are hotlinks the admin CSP
 * blocks anyway, and data: ones are disabled in the editor. Images are inserted
 * through the media library. Block ids (`data-block-id`) are stripped so every pasted
 * node gets a fresh one from BlockIdExtension, even when pasting from another GoLive
 * post. `<ol start>` isn't kept either: the block doc has no field for it, so the
 * number would reset on the next load.
 */
export function sanitizePastedHTML(html: string): string {
  if (typeof window === "undefined" || !html) return html

  // DOMParser documents are inert: no scripts run and no images load while we read.
  const doc = new DOMParser().parseFromString(html, "text/html")
  normalizeClipboardMarkup(doc.body)

  // Hand DOMPurify the parsed nodes (it imports them into its own body) rather than
  // re-serializing them to a string for a second parse. A fragment, because DOMPurify
  // refuses a <body> root it would have to remove.
  const fragment = doc.createDocumentFragment()
  fragment.append(...Array.from(doc.body.childNodes))
  return getPurifier().sanitize(fragment)
}

/**
 * Rewrites Google Docs / Word conventions into semantic HTML before sanitizing,
 * because the styles that carry them are about to be stripped:
 * - Docs wraps the whole selection in `<b style="font-weight:normal">`; unwrap it,
 *   or the paste would turn entirely bold once the style is gone.
 * - Docs and Word mark bold/italic/underline/strikethrough with inline styles on
 *   spans; wrap their content in strong/em/u/s (no strong inside headings), and lift
 *   spans that switch bold/italic off out of an enclosing <b>/<i>.
 * - Word fakes list bullets with `mso-list:Ignore` spans; drop them.
 * - Docs nests a sub-list directly inside the parent list; move it into the
 *   preceding <li> (or a new one), where the schema (listItem: paragraph block*)
 *   expects it.
 * Plus generic fixes for table cells, nav/details and blank-line <br>s (see below).
 */
function normalizeClipboardMarkup(root: HTMLElement) {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[style]"))) {
    const style = parseStyle(el.getAttribute("style") || "")

    if (style["mso-list"]?.toLowerCase() === "ignore") {
      el.remove()
      continue
    }

    const weight = style["font-weight"]?.toLowerCase()
    if ((el.tagName === "B" || el.tagName === "STRONG") && (weight === "normal" || weight === "400")) {
      el.replaceWith(...Array.from(el.childNodes))
      continue
    }

    if (el.tagName !== "SPAN") continue
    // A span that switches bold/italic back off inside <b>/<i> relied on the style
    // (TipTap's clearMark rule); lift it out of that ancestor instead.
    const fontStyle = style["font-style"]?.toLowerCase()
    if (weight === "normal" || weight === "400") liftOutOf(el, "b, strong", root)
    if (fontStyle === "normal") liftOutOf(el, "i, em", root)

    const wrappers: string[] = []
    // Headings are already bold (Docs styles their spans font-weight:700).
    const bold = weight === "bold" || weight === "bolder" || Number(weight) >= 600
    if (bold && !el.closest("h1, h2, h3, h4, h5, h6")) wrappers.push("strong")
    if (fontStyle === "italic") wrappers.push("em")
    const decoration = `${style["text-decoration"] || ""} ${style["text-decoration-line"] || ""}`.toLowerCase()
    // Docs styles every link underlined; the link itself already says that.
    if (decoration.includes("underline") && !el.closest("a")) wrappers.push("u")
    if (decoration.includes("line-through")) wrappers.push("s")
    for (const tag of wrappers) {
      const wrapper = el.ownerDocument.createElement(tag)
      wrapper.append(...Array.from(el.childNodes))
      el.append(wrapper)
    }
  }

  for (const list of Array.from(root.querySelectorAll("ul > ul, ul > ol, ol > ul, ol > ol"))) {
    const previous = list.previousElementSibling
    if (previous?.tagName === "LI") previous.append(list)
    else {
      // No item to nest under (the list starts indented, or skips a level): give it one.
      const li = list.ownerDocument.createElement("li")
      list.replaceWith(li)
      li.append(list)
    }
  }

  // Tables (#420) become table blocks: a <caption> moves out to the figure's caption (where
  // the table block's parse rule reads it), and every cell holds paragraphs only, the
  // only thing a cell may hold, so a heading or list in a pasted cell can't split the table.
  for (const caption of Array.from(root.querySelectorAll("table > caption"))) moveCaptionOut(caption)
  for (const cell of Array.from(root.querySelectorAll("td, th"))) {
    if (root.contains(cell)) flattenCell(cell as HTMLElement)
  }

  // ProseMirror doesn't treat these as block boundaries, so a nav (or a details) and the
  // text after it would run together into one paragraph. Make them divs.
  for (const cell of Array.from(root.querySelectorAll("caption, nav, details, summary"))) {
    const div = cell.ownerDocument.createElement("div")
    div.append(...Array.from(cell.childNodes))
    cell.replaceWith(div)
  }

  // A <br> between blocks is a blank line (Docs emits one per empty paragraph): make it
  // an empty paragraph, not a paragraph holding a lone hard break. Browsers append an
  // `Apple-interchange-newline` <br> to copied selections; that one is just dropped.
  for (const br of Array.from(root.querySelectorAll("br"))) {
    if (br.classList.contains("Apple-interchange-newline")) br.remove()
    else if (
      (br.parentElement === root || CONTAINER_TAGS.has(br.parentElement!.tagName)) &&
      isBlockBoundary(br.previousSibling, "previous") &&
      isBlockBoundary(br.nextSibling, "next")
    ) {
      br.replaceWith(br.ownerDocument.createElement("p"))
    }
  }
}

// Elements that hold blocks rather than text, where a lone <br> is a blank line.
const CONTAINER_TAGS = new Set([
  "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "ASIDE", "MAIN", "BLOCKQUOTE", "FIGURE",
])

const BLOCK_TAGS = new Set([
  ...CONTAINER_TAGS,
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "PRE", "HR", "ADDRESS",
  "HGROUP", "FIGCAPTION", "DL", "DT", "DD", "TABLE", "THEAD", "TBODY", "TFOOT", "TR",
])

// What a pasted cell's content is split into lines at (#420): every block element. Each
// line becomes a paragraph of the cell; an <hr> just ends one.
const CELL_LINE_TAGS = new Set([...BLOCK_TAGS, "TD", "TH", "CAPTION", "NAV", "DETAILS", "SUMMARY", "LI"])

/**
 * A pasted cell's content as paragraphs only (#420: cells are `paragraph+`): each block
 * element in it (a heading, a list item, a nested table's cell, …) ends a line, and the
 * inline content of each line goes in its own <p>. Whitespace between blocks is dropped.
 */
function flattenCell(cell: HTMLElement) {
  const doc = cell.ownerDocument
  const lines: HTMLElement[] = []
  let line: HTMLElement | null = null
  const walk = (parent: globalThis.Node) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE && CELL_LINE_TAGS.has((child as Element).tagName)) {
        line = null
        if ((child as Element).tagName !== "HR") walk(child)
        line = null
      } else if (child.nodeType === Node.TEXT_NODE && !line && !child.textContent!.trim()) {
        continue
      } else {
        if (!line) {
          line = doc.createElement("p")
          lines.push(line)
        }
        line.append(child)
      }
    }
  }
  walk(cell)
  cell.replaceChildren(...lines)
}

/** `<table><caption>X</caption>…</table>` → `<figure><table>…</table><figcaption>X</figcaption></figure>`. */
function moveCaptionOut(caption: Element) {
  const table = caption.parentElement!
  const doc = caption.ownerDocument
  const figcaption = doc.createElement("figcaption")
  figcaption.append(...Array.from(caption.childNodes))
  caption.remove()
  const figure = table.parentElement?.tagName === "FIGURE" ? table.parentElement : doc.createElement("figure")
  if (figure !== table.parentElement) {
    table.replaceWith(figure)
    figure.append(table)
  }
  // A figure with a caption of its own keeps both texts, the table's first.
  const existing = figure.querySelector(":scope > figcaption")
  if (existing) existing.prepend(...Array.from(figcaption.childNodes), doc.createTextNode(" "))
  else figure.append(figcaption)
}

/**
 * Moves `el` out of its closest `selector` ancestor (within `root`) by splitting that
 * ancestor around it: content before and after `el` stays wrapped, `el` doesn't.
 */
function liftOutOf(el: HTMLElement, selector: string, root: HTMLElement) {
  const ancestor = el.parentElement?.closest(selector)
  if (!ancestor || !root.contains(ancestor)) return
  const doc = el.ownerDocument
  const range = doc.createRange()

  range.setStart(ancestor, 0)
  range.setEndBefore(el)
  const before = range.extractContents()
  range.setStartAfter(el)
  range.setEnd(ancestor, ancestor.childNodes.length)
  const after = range.extractContents()

  for (const [fragment, place] of [[before, "before"], [after, "after"]] as const) {
    if (!fragment.childNodes.length) continue
    const copy = ancestor.cloneNode(false) as Element
    copy.append(fragment)
    ancestor[place](copy)
  }
  ancestor.replaceWith(...Array.from(ancestor.childNodes))
}

/**
 * True when there's no inline content next to a <br> on that side: only the edge of
 * its parent or a block element, skipping whitespace-only text and comments.
 */
function isBlockBoundary(node: ChildNode | null, direction: "previous" | "next"): boolean {
  while (node) {
    if (node.nodeType === Node.COMMENT_NODE || (node.nodeType === Node.TEXT_NODE && !node.textContent!.trim())) {
      node = direction === "previous" ? node.previousSibling : node.nextSibling
      continue
    }
    return node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((node as Element).tagName)
  }
  return true
}

function parseStyle(style: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":")
    if (colon < 0) continue
    out[declaration.slice(0, colon).trim().toLowerCase()] = declaration.slice(colon + 1).trim()
  }
  return out
}

// Wrapper node types a pasted slice context may recreate: lists, quotes and the
// containers (#414), so a slice copied from inside a group pastes into a new group with
// default attrs.
// The to-do list and the callout (#419) wrap their content the same way, and so do a
// table's parts (#420), so cells copied from a table paste as cells.
const SLICE_CONTEXT_TYPES = new Set([
  "bulletList", "orderedList", "listItem", "blockquote", "taskList", "taskItem", "callout", ...CONTAINER_NODE_NAMES,
  "tableBlock", "table", "tableRow", "tableCell",
])

/**
 * ProseMirror's own clipboard HTML carries `data-pm-slice="<openStart> <openEnd>
 * <context JSON>"`, where the context is a flat [typeName, attrs, …] list of the
 * wrapper nodes the slice was cut from. ProseMirror recreates those nodes with
 * `type.create(attrs)`, which validates nothing, and any web page can set the
 * attribute. So keep it only when every wrapper is a list, quote or container type, with
 * attrs reset to defaults (null), which also drops copied block ids. Returns null to
 * remove it.
 */
function sanitizeSliceContext(value: string): string | null {
  const match = /^(\d+ \d+(?: -\d+)?) (.*)$/s.exec(value)
  if (!match) return null
  try {
    const context = JSON.parse(match[2])
    if (!Array.isArray(context) || context.length % 2 !== 0) return null
    const safe: (string | null)[] = []
    for (let i = 0; i < context.length; i += 2) {
      if (!SLICE_CONTEXT_TYPES.has(context[i])) return null
      safe.push(context[i], null)
    }
    return `${match[1]} ${JSON.stringify(safe)}`
  } catch {
    return null
  }
}

export const PasteSanitizer = Extension.create({
  name: "pasteSanitizer",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pasteSanitizerPluginKey,
        props: {
          transformPastedHTML: (html) => sanitizePastedHTML(html),
        },
      }),
    ]
  },
})

export default PasteSanitizer
