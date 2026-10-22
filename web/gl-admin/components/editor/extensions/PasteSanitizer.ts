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
  "div", "section", "article", "header", "footer", "aside", "main",
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

// A private DOMPurify instance, so our hooks don't leak into any other caller.
function getPurifier() {
  if (purifier) return purifier
  purifier = DOMPurify(window)
  purifier.addHook("uponSanitizeAttribute", (node, data) => {
    if (data.attrName === "class") {
      // Keep only `language-*` on <code>: CodeBlockLowlight reads the language from it.
      const match = node.nodeName === "CODE" ? CODE_LANGUAGE_CLASS.exec(data.attrValue) : null
      if (match) data.attrValue = match[1]
      else data.keepAttr = false
    } else if (data.attrName === "data-pm-slice") {
      const value = stripSliceContextIds(data.attrValue)
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

  return getPurifier().sanitize(doc.body.innerHTML, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "class", "data-pm-slice"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP,
    FORBID_CONTENTS,
    KEEP_CONTENT: true,
  })
}

/**
 * Rewrites Google Docs / Word conventions into semantic HTML before sanitizing,
 * because the styles that carry them are about to be stripped:
 * - Docs wraps the whole selection in `<b style="font-weight:normal">`; unwrap it,
 *   or the paste would turn entirely bold once the style is gone.
 * - Docs and Word mark bold/italic/underline/strikethrough with inline styles on
 *   spans; wrap their content in strong/em/u/s.
 * - Word fakes list bullets with `mso-list:Ignore` spans; drop them.
 * - Docs nests a sub-list directly inside the parent list; move it into the
 *   preceding <li>, where the schema (listItem: paragraph block*) expects it.
 * Plus two generic fixes for table cells and blank-line <br>s (see below).
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
    const wrappers: string[] = []
    if (weight === "bold" || weight === "bolder" || Number(weight) >= 600) wrappers.push("strong")
    if (style["font-style"]?.toLowerCase() === "italic") wrappers.push("em")
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
  }

  // ProseMirror doesn't treat table cells as block boundaries, so a row's cells would
  // run together into one paragraph. Make each cell (and caption) a div.
  for (const cell of Array.from(root.querySelectorAll("td, th, caption"))) {
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
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "PRE", "HR", "NAV",
  "FIGCAPTION", "DL", "DT", "DD", "TABLE", "THEAD", "TBODY", "TFOOT", "TR",
])

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

/**
 * ProseMirror's own clipboard HTML carries `data-pm-slice="<openStart> <openEnd>
 * <context JSON>"`, where the context is a flat [typeName, attrs, …] list of the
 * wrapper nodes the slice was cut from. Keep it (internal pastes keep their list/quote
 * context) but drop block ids from those attrs, like everywhere else in a paste.
 * Returns null to remove an attribute that doesn't parse.
 */
function stripSliceContextIds(value: string): string | null {
  const match = /^(\d+ \d+(?: -\d+)?) (.*)$/s.exec(value)
  if (!match) return null
  try {
    const context = JSON.parse(match[2])
    if (!Array.isArray(context)) return null
    for (const item of context) {
      if (item && typeof item === "object" && !Array.isArray(item)) delete item["data-block-id"]
    }
    return `${match[1]} ${JSON.stringify(context)}`
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
