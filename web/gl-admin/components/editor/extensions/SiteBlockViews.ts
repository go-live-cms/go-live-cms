import type { Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import type { EditorView, NodeView } from "@tiptap/pm/view"
import {
  normalizeSiteBlockAttrs,
  SEARCH_DEFAULTS,
  SITE_BLOCK_CONTEXTS,
  SITE_BLOCK_ICONS,
  SITE_BLOCK_INERT_NOTE,
  SITE_BLOCK_LABELS,
  SITE_LOGO_DEFAULT_WIDTH,
  POST_EXCERPT_DEFAULT_WORDS,
  QUERY_DEFAULT_PER_PAGE,
  RELATED_POSTS_DEFAULT_COUNT,
  siteBlockTypeOfNode,
  type SiteBlockType,
} from "@gl-admin/lib/blocks-spec"
import { editorDocKind, editorSiteBridge } from "./SiteBlocks"

/**
 * The site blocks' views (#488, the blocks canvas's "Site blocks in the editor" board): a
 * **labelled placeholder** for each one ("Site title · Paragraph · links home"), never the
 * site's data. Rendering real data here would mean fetching in node views and two renderers
 * that must agree (design 4.4); the Site editor's preview shows the real thing.
 *
 * In a post (the editor's `SiteBlockContext`, `editorDocKind`) every site block is inert:
 * the view says so ("… only works in the Site editor"), as the canvas's "In a post" state
 * does, so whoever finds one knows it shows nothing and can remove it. A template part in a
 * part says the same, since a part can't hold a part.
 *
 * Plain DOM, no React, nothing written to the doc: the view only reads its node (rule 7).
 */

const PART_LOCK = "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4"

const ICON_OF: Readonly<Record<SiteBlockType, string>> = { ...SITE_BLOCK_ICONS, template_part: PART_LOCK }

/** "header" → "Header", "promo_bar" → "Promo bar". */
export function partName(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The placeholder's second line: what the block is set to show, from its attrs only (the
 * canvas's "Paragraph · links home", "Primary · column", "“Search the blog” · Search").
 */
export function siteBlockSummary(type: SiteBlockType, attrs: Record<string, unknown>): string {
  const a = normalizeSiteBlockAttrs(type, attrs)
  const linksHome = a.link === false ? null : "links home"
  switch (type) {
    case "site_title":
      return [a.level ? `H${a.level}` : "Paragraph", linksHome].filter(Boolean).join(" · ")
    case "site_tagline":
      return "From Settings › General"
    case "site_logo":
      return [`${(a.width as number | undefined) ?? SITE_LOGO_DEFAULT_WIDTH} px`, linksHome].filter(Boolean).join(" · ")
    case "navigation": {
      const source = a.menuId !== undefined ? `Menu ${a.menuId}` : a.location !== undefined ? `Location: ${a.location}` : "No menu chosen"
      return [source, a.layout === "column" ? "column" : "row", a.overlay === "never" ? "never folds" : null].filter(Boolean).join(" · ")
    }
    case "search":
      return `“${(a.placeholder as string | undefined) ?? (a.label as string | undefined) ?? SEARCH_DEFAULTS.label}” · ${(a.button as string | undefined) ?? SEARCH_DEFAULTS.button}`
    case "template_part":
      return typeof a.slug === "string" ? "Template part" : "Choose a part in the Block tab"
    // #489 (the canvas's "Query loop · This page’s list · 10 per page", "Post title · H3 · links to the post").
    case "query":
      return queryLoopSummary(a)
    case "post_template":
      return "Repeats for each post"
    case "query_no_results":
      return "When the list is empty"
    case "query_pagination":
      return "← Newer · 1 2 3 … · Older →, for the page’s own list"
    case "query_title":
      return `${a.level === 2 ? "H2" : "H1"} · the page’s list, named`
    case "term_description":
      return "The listed category’s or tag’s description"
    case "post_title":
      return [a.level ? `H${a.level}` : "Sized for the page", a.link === true ? "links to the post" : a.link === false ? "no link" : null].filter(Boolean).join(" · ")
    case "post_content":
      return "The post’s blocks render here, with their own anchors."
    case "post_excerpt":
      return `${(a.length as number | undefined) ?? POST_EXCERPT_DEFAULT_WORDS} words`
    case "post_featured_image":
      return [ASPECT_LABELS[(a.aspect as string | undefined) ?? "auto"], a.link === true ? "links to the post" : null].filter(Boolean).join(" · ")
    case "post_date":
      return `${a.which === "modified" ? "updated" : "published"}, ${a.format === "short" ? "short" : "long"}`
    case "post_byline":
      return [a.avatars === false ? "Names only" : "With avatars", a.readingTime === true ? "reading time" : null].filter(Boolean).join(" · ")
    case "post_terms":
      return typeof a.taxonomy === "string" ? `Taxonomy: ${a.taxonomy}` : "Category"
    case "post_navigation":
      return "Older · Newer"
    // #497
    case "related_posts": {
      const count = (a.count as number | undefined) ?? RELATED_POSTS_DEFAULT_COUNT
      return [`“More to read” · ${count} ${count === 1 ? "post" : "posts"}`, typeof a.taxonomy === "string" ? `sharing a ${a.taxonomy}` : null].filter(Boolean).join(", ")
    }
    case "author_cards":
      return "“Written by” · the post’s credited authors"
    case "table_of_contents":
      return "“On this page” · the post’s H2s and H3s, from three headings"
    case "color_scheme_switch":
      return `Light · Dark · System, ${a.variant === "menu" ? "a list" : "side by side"}`
  }
}

const ASPECT_LABELS: Readonly<Record<string, string>> = { auto: "Original shape", "16-9": "16:9", "3-2": "3:2", "1-1": "1:1" }

/** A query's line (the canvas's "This page’s list · 10 per page", "Posts in Guides · 3, newest first"). */
export function queryLoopSummary(attrs: Record<string, unknown>): string {
  const a = normalizeSiteBlockAttrs("query", attrs)
  if (a.inherit === true) return "This page’s list · its pages"
  const type = typeof a.postType === "string" ? a.postType : "Posts"
  const filters = [Array.isArray(a.termIds) ? `in ${a.termIds.length === 1 ? "1 term" : `${a.termIds.length} terms`}` : null, a.authorId ? "by one author" : null]
  const count = (a.perPage as number | undefined) ?? QUERY_DEFAULT_PER_PAGE
  const order = a.orderBy === "title" ? (a.order === "asc" ? "A to Z" : "Z to A") : a.order === "asc" ? "oldest first" : "newest first"
  return `${[type, ...filters].filter(Boolean).join(" ")} · ${count}, ${order}`
}

/** The inert notice for a site block in a document of `kind`, or null where it works. */
export function siteBlockInertNote(type: SiteBlockType, kind: "post" | "template" | "part"): string | null {
  if (SITE_BLOCK_CONTEXTS[type].includes(kind)) return null
  if (kind === "part") return `${SITE_BLOCK_LABELS[type]} can't go in a part, so it shows nothing. You can remove it.`
  return `${SITE_BLOCK_LABELS[type]} ${SITE_BLOCK_INERT_NOTE}`
}

function svgIcon(path: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg"
  const svg = document.createElementNS(ns, "svg")
  svg.setAttribute("width", "16")
  svg.setAttribute("height", "16")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("fill", "none")
  svg.setAttribute("stroke", "currentColor")
  svg.setAttribute("stroke-width", "1.75")
  svg.setAttribute("stroke-linecap", "round")
  svg.setAttribute("stroke-linejoin", "round")
  svg.setAttribute("aria-hidden", "true")
  const p = document.createElementNS(ns, "path")
  p.setAttribute("d", path)
  svg.append(p)
  return svg
}

export class SiteBlockView implements NodeView {
  dom: HTMLElement
  private node: PMNode
  private readonly type: SiteBlockType
  private openButton: HTMLButtonElement | null = null

  constructor(
    node: PMNode,
    _view: EditorView,
    _getPos: () => number | undefined,
    private readonly editor: Editor
  ) {
    this.node = node
    this.type = siteBlockTypeOfNode(node.type.name) as SiteBlockType
    this.dom = document.createElement("div")
    this.dom.setAttribute("contenteditable", "false")
    this.dom.dataset.type = this.type.replace(/_/g, "-")
    this.render()
  }

  private render() {
    const kind = editorDocKind(this.editor)
    const inert = siteBlockInertNote(this.type, kind)
    const isPart = this.type === "template_part"
    this.dom.className = `editor-site-block${isPart ? " editor-site-block--part" : ""}${inert ? " is-inert" : ""}`
    const id = this.node.attrs["data-block-id"]
    if (typeof id === "string" && id) this.dom.setAttribute("data-block-id", id)
    else this.dom.removeAttribute("data-block-id")

    const tile = document.createElement("span")
    tile.className = "editor-site-block__tile"
    tile.append(svgIcon(ICON_OF[this.type]))

    const text = document.createElement("span")
    text.className = "editor-site-block__text"
    const name = document.createElement("b")
    name.className = "editor-site-block__name"
    const slug = isPart ? (normalizeSiteBlockAttrs("template_part", this.node.attrs).slug as string | undefined) : undefined
    name.textContent = slug ? partName(slug) : SITE_BLOCK_LABELS[this.type]
    const detail = document.createElement("span")
    detail.className = "editor-site-block__detail"
    // A part card in the Site editor (#493, design 7.5): the part's state and a button that
    // opens it in its own editor (one binding per editor: its content is never shown here).
    const bridge = isPart && !inert && slug ? editorSiteBridge(this.editor) : null
    const status = bridge?.partStatus?.(slug!) ?? null
    detail.textContent = status?.detail ?? siteBlockSummary(this.type, this.node.attrs)
    text.append(name, detail)

    const children: Node[] = [tile, text]
    if (bridge?.openPart) {
      const open = document.createElement("button")
      open.type = "button"
      open.className = "gl-button gl-button--secondary gl-button--sm editor-site-block__open"
      open.textContent = status?.action ?? "Edit part"
      open.setAttribute("aria-label", `${open.textContent}: ${name.textContent}`)
      open.addEventListener("click", (event) => {
        event.preventDefault()
        bridge.openPart?.(slug!)
      })
      this.openButton = open
      children.push(open)
    } else this.openButton = null
    if (inert) {
      const note = document.createElement("p")
      note.className = "editor-site-block__note"
      note.setAttribute("role", "note")
      note.textContent = inert
      children.push(note)
    }
    this.dom.replaceChildren(...children)
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

  ignoreMutation() {
    return true
  }

  // The part card's button handles its own clicks and keys (ProseMirror would select the node).
  stopEvent(event: Event) {
    return !!this.openButton && event.target instanceof globalThis.Node && this.openButton.contains(event.target)
  }
}

/**
 * The query loop's containers (#489, the canvas's query frame): a labelled header ("Query
 * loop · Posts · 10, newest first", "Post template · Repeats for each post", "No results · When
 * the list is empty") above their blocks, which stay editable. Inert in a post, and it says so,
 * like the atoms. Plain DOM; the header only reads the node (rule 7).
 */
export class SiteContainerView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private header: HTMLElement
  private node: PMNode
  private readonly type: SiteBlockType

  constructor(
    node: PMNode,
    _view: EditorView,
    _getPos: () => number | undefined,
    private readonly editor: Editor
  ) {
    this.node = node
    this.type = siteBlockTypeOfNode(node.type.name) as SiteBlockType
    this.dom = document.createElement("div")
    this.dom.dataset.type = this.type.replace(/_/g, "-")
    // Remote carets' name labels flip at this edge, as in a group (#417).
    this.dom.setAttribute("data-collab-bounds", "")
    this.header = document.createElement("div")
    this.header.className = "editor-site-container__head"
    this.header.setAttribute("contenteditable", "false")
    this.contentDOM = document.createElement("div")
    this.contentDOM.className = "editor-site-container__content"
    this.dom.append(this.header, this.contentDOM)
    this.render()
  }

  private render() {
    const inert = siteBlockInertNote(this.type, editorDocKind(this.editor))
    this.dom.className = `editor-site-container editor-site-container--${this.type.replace(/_/g, "-")}${inert ? " is-inert" : ""}`
    const id = this.node.attrs["data-block-id"]
    if (typeof id === "string" && id) this.dom.setAttribute("data-block-id", id)
    else this.dom.removeAttribute("data-block-id")
    const tile = document.createElement("span")
    tile.className = "editor-site-block__tile"
    tile.append(svgIcon(ICON_OF[this.type]))
    const name = document.createElement("b")
    name.className = "editor-site-block__name"
    name.textContent = SITE_BLOCK_LABELS[this.type]
    const detail = document.createElement("span")
    detail.className = "editor-site-block__detail"
    detail.textContent = siteBlockSummary(this.type, this.node.attrs)
    const children: Node[] = [tile, name, detail]
    if (inert) {
      const note = document.createElement("p")
      note.className = "editor-site-block__note"
      note.setAttribute("role", "note")
      note.textContent = inert
      children.push(note)
    }
    this.header.replaceChildren(...children)
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    if (mutation.type === "selection") return false
    return !this.contentDOM.contains(mutation.target as globalThis.Node)
  }
}
