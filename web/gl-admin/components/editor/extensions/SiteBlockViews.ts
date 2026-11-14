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
  siteBlockTypeOfNode,
  type SiteBlockType,
} from "@gl-admin/lib/blocks-spec"
import { editorDocKind } from "./SiteBlocks"

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
  }
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
    detail.textContent = siteBlockSummary(this.type, this.node.attrs)
    text.append(name, detail)

    const children: Node[] = [tile, text]
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
}
