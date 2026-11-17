/**
 * The parity check of the default theme's block templates (#498, design `docs/design/theme-builder.md`
 * 5.7): a page its code layout rendered (#484's snapshots, `__snapshots__/layouts/`) and the same
 * page its block template renders are read into a DOM and written out the same way, so the test
 * compares them element by element (tags, attributes, text) after only the differences this
 * conversion intends, `BLOCK_TEMPLATE_DIFFERENCES`. Each is a rule here and a line in the PR; a
 * difference with no rule fails the test.
 *
 * Test support only (the theme's `*.astro.test.ts` reads it); nothing on the site imports it.
 */
import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"

/** A template or part the theme ships (`templates/<slug>.json`, `parts/<slug>.json`). */
export function shippedTemplate(dir: "templates" | "parts", slug: string): { title: string; doc: BlockDocV1 } {
  return JSON.parse(readFileSync(new URL(`./${dir}/${slug}.json`, import.meta.url), "utf8"))
}

/** What the conversion changes on purpose, by rule: the PR lists these. */
export const BLOCK_TEMPLATE_DIFFERENCES = [
  "Layout wrappers: a code layout wraps its pieces in elements the theme lays them out with (`.container`, `article.post`, `header.post-header`, `footer.post-end`, `.post-grid`, `aside.post-aside`, `header.archive-header`, `header.home-header`, `.author-header__text`, `.search-page`, `.error-page`, `header.page-band`, `.button-row`, `header.site-header`, `.header-actions`, `footer.site-footer`, `.footer-grid`, `.footer-bottom`); a block template has the blocks' own (`header.template-part`, `footer.template-part`, `.block-content`, `.query-loop`, `.nav-block`, `p.site-title-block`, `.columns`/`.column`, `div.group`, `div.buttons`, `.search-results-block`). The theme's CSS lays the blocks out by template (`[data-template]`).",
  "The page's `div.site` also has `site--block-template` and `data-template=\"<slug>\"`.",
  "The header's menu button and phone menu (`button.menu-btn`, `dialog#site-menu`) come right after the navigation row, before the search link and the theme button (they belong to the navigation block); the theme's CSS keeps the button last in the row.",
  "The submenus' ids carry the navigation block's id (`nav-sub-header-navigation-1` for `nav-sub-1`), and a search field's id is the block's own (`search-…` for `search-q`, `q404`).",
  "On the front page the footer's site title is marked `aria-current=\"page\"`, as the header's is.",
  "The embed loader (`/gl-embeds.js`) is at the end of the page, not at the end of the post's body; still once.",
  "A post's body (`div.prose`) has no `measure` or `page-body` class: its width is the template's.",
  "The search form has the `search-block` class, the copyright line `site-copyright`.",
  "The sidebar post's aside is the second column of a Columns block, not an `aside` landmark labelled \"About this post\".",
  "The full-width page's title band is a tinted full-width Group (`div.group.is-tinted.alignfull`), not `header.page-band`.",
  "The 404 page's \"Recent posts\" is a Heading block (`h2` with its own id, no `section-title` class, there even when the list is empty) over a query loop of three titles (`ul.link-list`), not `section.error-recent`.",
  "An empty list says so in `div.query-no-results > p`, not `p.empty-state.dek` (no fixture has one).",
  "React adds `<link rel=\"preload\" as=\"image\" fetchpriority=\"high\">` at the start of the body for the image the page shows first (the featured image, the front page's featured post), which the code layouts only marked `fetchpriority=\"high\"`.",
  "On a page, a heading of the body that slugs to `content` is `content-2`, as on a post: the code page layouts didn't reserve the page's own ids, so it took `main#content`'s (the skip link's target).",
] as const

/** The frame elements unwrapped (replaced by their children) on each side. */
const CODE_WRAPPERS = [
  "header.site-header",
  ".site-header-inner:not(.mobile-menu-bar)",
  ".header-actions",
  "footer.site-footer",
  ".footer-grid",
  "div.footer-col",
  ".footer-bottom",
  ".container:not(.mobile-menu-bar)",
  "article.post",
  "article.page",
  "header.post-header",
  "footer.post-end",
  ".post-grid",
  "aside.post-aside",
  ".post-aside-inner",
  "header.archive-header",
  "header.home-header",
  ".author-header__text",
  ".search-page",
  ".error-page",
  "header.page-band",
  ".button-row",
  "section.error-recent",
]
const TEMPLATE_WRAPPERS = [
  "header.template-part",
  "footer.template-part",
  ".query-loop",
  ".nav-block",
  "p.site-title-block",
  ".columns",
  ".column",
  "div.group",
  "div.buttons",
  ".search-results-block",
]

function unwrap(element: Element) {
  element.replaceWith(...Array.from(element.childNodes))
}

function unwrapAll(root: Element, selectors: readonly string[]) {
  for (const selector of selectors) {
    // Outermost first, so nested matches unwrap too.
    for (const element of Array.from(root.querySelectorAll(selector))) unwrap(element)
  }
}

/** Ids that differ by design (submenus, search fields), renamed in reading order on both sides with their references. */
function renameIds(document: Document) {
  const names = new Map<string, string>()
  const elements = Array.from(document.querySelectorAll("[id]")).filter((el) => /^nav-sub-/.test(el.id) || (el.tagName === "INPUT" && el.getAttribute("type") === "search"))
  for (const el of elements) if (!names.has(el.id)) names.set(el.id, `renamed-${names.size + 1}`)
  for (const el of Array.from(document.querySelectorAll("*"))) {
    for (const attr of ["id", "for", "aria-controls"]) {
      const value = el.getAttribute(attr)
      if (value && names.has(value)) el.setAttribute(attr, names.get(value)!)
    }
  }
}

function removeClasses(document: Document, selector: string, classes: readonly string[]) {
  for (const el of Array.from(document.querySelectorAll(selector))) {
    for (const name of classes) el.classList.remove(name)
  }
}

/** One element per line, attributes sorted, text trimmed and its whitespace collapsed: a readable, stable form for the diff. */
function serialize(node: Node, depth = 0, out: string[] = []): string[] {
  const pad = "  ".repeat(depth)
  if (node.nodeType === 3) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim()
    if (text) out.push(`${pad}${text}`)
    return out
  }
  if (node.nodeType !== 1) return out
  const el = node as Element
  const attrs = Array.from(el.attributes)
    .map((a) => [a.name, a.name === "class" ? a.value.split(/\s+/).filter(Boolean).sort().join(" ") : a.value.replace(/\s+/g, " ").trim()] as const)
    .filter(([name, value]) => !(name === "class" && value === ""))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("")
  const tag = el.tagName.toLowerCase()
  // A <style> or <script>'s text is compared as is (the tokens, JSON-LD).
  if (tag === "style" || tag === "script") {
    out.push(`${pad}<${tag}${attrs}>${(el.textContent ?? "").trim()}</${tag}>`)
    return out
  }
  out.push(`${pad}<${tag}${attrs}>`)
  for (const child of Array.from(el.childNodes)) serialize(child, depth + 1, out)
  return out
}

export interface ComparablePage {
  /** The page as compared: one element or text per line. */
  page: string
  /** The ids of the post body's headings, in order. */
  bodyHeadingIds: string[]
  /** How many `/gl-embeds.js` the page loads. */
  embedLoaders: number
}

/** A page as the parity check compares it (`BLOCK_TEMPLATE_DIFFERENCES` applied), from the code layout's side or the template's. */
export function comparablePage(html: string, side: "code" | "template", name: string): ComparablePage {
  const dom = new JSDOM(html)
  const { document } = dom.window
  const root = document.documentElement
  // React's text separators (`<!-- -->`) go, and the text they split is one text again.
  const walker = document.createTreeWalker(root, dom.window.NodeFilter.SHOW_COMMENT)
  const comments: Node[] = []
  while (walker.nextNode()) comments.push(walker.currentNode)
  for (const comment of comments) comment.parentNode?.removeChild(comment)
  root.normalize()
  if (side === "code" && name.startsWith("page-")) {
    // The code page layouts let a body heading take `main#content`'s id; the template reserves it.
    for (const el of Array.from(document.querySelectorAll('.prose [id="content"]'))) el.id = "content-2"
  }
  // The body's headings and the embed loader, before anything moves.
  const bodyHeadingIds = Array.from(document.querySelectorAll(".prose :is(h2, h3, h4, h5, h6)[id]")).map((el) => el.id)
  const loaders = Array.from(document.querySelectorAll('script[src="/gl-embeds.js"]'))
  for (const script of loaders) script.remove()

  if (side === "template") {
    // React hoists a preload for an image marked `fetchpriority="high"`; the image itself is compared.
    for (const link of Array.from(document.querySelectorAll('body link[rel="preload"][as="image"]'))) link.remove()
    const site = document.querySelector("div.site")
    site?.classList.remove("site--block-template")
    site?.removeAttribute("data-template")
    // The phone menu belongs to the navigation block: put it where the code header has it, after the theme button.
    const themeMenu = document.querySelector(".theme-menu")
    const menuButton = document.querySelector("button.menu-btn")
    const dialog = document.querySelector("dialog#site-menu")
    const header = document.querySelector("header.template-part--header")
    if (themeMenu && menuButton) themeMenu.after(menuButton)
    // The code header's dialog follows the header element.
    if (header && dialog) header.after(dialog)
    // The footer's title on the front page.
    if (name === "home") document.querySelector("footer.template-part--footer a.site-title")?.removeAttribute("aria-current")
    removeClasses(document, ".search-form", ["search-block"])
    removeClasses(document, ".site-copyright", ["site-copyright"])
    unwrapAll(root, TEMPLATE_WRAPPERS)
  } else {
    removeClasses(document, ".prose", ["measure", "page-body"])
    unwrapAll(root, CODE_WRAPPERS)
  }
  // Both sides: every doc's `div.block-content` (the post body's on both, the template's too).
  unwrapAll(root, [".block-content"])
  if (name === "error-404") {
    // The 404's "Recent posts" heading is a Heading block's in the template (its own id, no class).
    for (const heading of Array.from(document.querySelectorAll("h2"))) if (heading.textContent?.trim() === "Recent posts") heading.remove()
  }
  renameIds(document)
  const page = serialize(root).join("\n")
  dom.window.close()
  return { page, bodyHeadingIds, embedLoaders: loaders.length }
}
