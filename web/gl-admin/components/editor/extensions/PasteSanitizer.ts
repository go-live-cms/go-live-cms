import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "prosemirror-state"
import DOMPurify from "dompurify"

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

let purifier: ReturnType<typeof DOMPurify> | null = null

// A private DOMPurify instance, so our hooks and config don't leak into any other caller.
function getPurifier() {
  if (purifier) return purifier
  purifier = DOMPurify(window)
  purifier.setConfig({
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "class", "data-pm-slice"],
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

  // ProseMirror doesn't treat these as block boundaries, so a row's cells (or a nav
  // and the text after it) would run together into one paragraph. Make them divs.
  for (const cell of Array.from(root.querySelectorAll("td, th, caption, nav, details, summary"))) {
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

// Wrapper node types a pasted slice context may recreate.
const SLICE_CONTEXT_TYPES = new Set(["bulletList", "orderedList", "listItem", "blockquote"])

/**
 * ProseMirror's own clipboard HTML carries `data-pm-slice="<openStart> <openEnd>
 * <context JSON>"`, where the context is a flat [typeName, attrs, …] list of the
 * wrapper nodes the slice was cut from. ProseMirror recreates those nodes with
 * `type.create(attrs)`, which validates nothing, and any web page can set the
 * attribute. So keep it only when every wrapper is a list/quote type, with attrs reset
 * to defaults (null), which also drops copied block ids. Returns null to remove it.
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
