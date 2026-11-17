import { Extension, mergeAttributes, Node, type JSONContent } from "@tiptap/core"
import {
  containerContent,
  SITE_BLOCK_NODE_NAMES,
  siteBlockNodeAttrs,
  type SiteAtomType,
  type SiteBlockType,
  type SiteContainerType,
} from "@gl-admin/lib/blocks-spec"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    siteBlocks: {
      /**
       * A site block (#488, #489) for the caret's line, with its default attrs. A query loop
       * comes whole (`siteBlockContent`): a post template with a title, date and excerpt, the
       * pager and "no results".
       */
      insertSiteBlock: (type: SiteBlockType, attrs?: Record<string, unknown>) => ReturnType
    }
  }
}

/** What "no results" says until someone changes it (the blocks canvas's). */
export const QUERY_NO_RESULTS_TEXT = "Nothing here yet."

/** The node a site block starts as: its default attrs, and a container's starting blocks. */
export function siteBlockContent(type: SiteBlockType, attrs: Record<string, unknown> = {}): JSONContent {
  const node = (t: SiteBlockType, a: Record<string, unknown> = {}, content?: JSONContent[]): JSONContent => ({
    type: SITE_BLOCK_NODE_NAMES[t],
    attrs: siteBlockNodeAttrs(t, a),
    ...(content ? { content } : {}),
  })
  switch (type) {
    case "query":
      return node("query", attrs, [
        node("post_template", {}, [node("post_title"), node("post_date", { format: "short" }), node("post_excerpt")]),
        node("query_pagination"),
        node("query_no_results", {}, [{ type: "paragraph", content: [{ type: "text", text: QUERY_NO_RESULTS_TEXT }] }]),
      ])
    case "post_template":
      return node("post_template", {}, [node("post_title")])
    case "query_no_results":
      return node("query_no_results", {}, [{ type: "paragraph", content: [{ type: "text", text: QUERY_NO_RESULTS_TEXT }] }])
    default:
      return node(type, attrs)
  }
}

/**
 * The site blocks (#488, Block Spec rules in `blocks-spec/siteBlocks.ts`, design
 * `docs/design/theme-builder.md` 4): `siteTitle`, `siteTagline`, `siteLogo`, `navigation`,
 * `search`, `templatePart`. Schema only, no DOM code: the collab server builds the same
 * schema (7.4: one schema, one fingerprint, whatever the document). Views are
 * `SiteBlockViews.ts`.
 *
 * - **Atoms**, each attr a node attribute, last writer wins. None holds text of its own: what
 *   they show is the site's, read on the page.
 * - **Not in the `block` group** (`STANDALONE_FLOW_NODE_NAMES`): a block of the doc or of a
 *   container that holds flow, never part of a quote's or a list item's content.
 * - **No parse rule, on purpose** (design 4.4, like Custom HTML, #428): no HTML, pasted or
 *   otherwise, makes one, so paste can't put one in a post. `renderHTML` writes an empty
 *   element for the clipboard and the attrs are never rendered, so a copy pastes nothing.
 */
function siteNode(type: SiteAtomType) {
  const attributes = siteBlockNodeAttrs(type, {})
  const name = SITE_BLOCK_NODE_NAMES[type]
  const dataType = type.replace(/_/g, "-")
  return Node.create({
    name,
    atom: true,
    selectable: true,
    draggable: false,

    addAttributes() {
      return Object.fromEntries(
        Object.entries(attributes).map(([attr, value]) => [attr, { default: value, rendered: false, parseHTML: () => null }])
      )
    },

    renderHTML({ HTMLAttributes }) {
      return ["div", mergeAttributes({ "data-type": dataType, class: "editor-site-block" }, HTMLAttributes)]
    },
  })
}

// Each node's attrs and defaults are the Block Spec's (`siteBlockNodeAttrs` of no attrs), so
// the editor, the bridge and the store share one list. The fingerprint (#416) includes them,
// so a tab that didn't know one is refused.
export const SiteTitle = siteNode("site_title")
export const SiteTagline = siteNode("site_tagline")
export const SiteLogo = siteNode("site_logo")
export const Navigation = siteNode("navigation")
export const Search = siteNode("search")
export const TemplatePart = siteNode("template_part")
// #489: the post blocks, the query title, the term description and the query's pager.
export const QueryTitle = siteNode("query_title")
export const TermDescription = siteNode("term_description")
export const PostTitle = siteNode("post_title")
export const PostContent = siteNode("post_content")
export const PostExcerpt = siteNode("post_excerpt")
export const PostFeaturedImage = siteNode("post_featured_image")
export const PostDate = siteNode("post_date")
export const PostByline = siteNode("post_byline")
export const PostTerms = siteNode("post_terms")
export const PostNavigation = siteNode("post_navigation")
// #497: related posts, author cards, the table of contents and the colour scheme switch.
export const RelatedPosts = siteNode("related_posts")
export const AuthorCards = siteNode("author_cards")
export const TableOfContents = siteNode("table_of_contents")
export const ColorSchemeSwitch = siteNode("color_scheme_switch")
// #498: the count, the author's avatar, the search results, the post's details, the copyright
// line and the GoLive credit (the default theme's pieces site blocks I to III didn't cover).
export const QueryTotal = siteNode("query_total")
export const AuthorAvatar = siteNode("author_avatar")
export const SearchResults = siteNode("search_results")
export const PostFacts = siteNode("post_facts")
export const SiteCopyright = siteNode("site_copyright")
export const GoliveCredit = siteNode("golive_credit")
export const QueryPagination = siteNode("query_pagination")

/**
 * The query loop's containers (#489): rows of the nesting table, so their content expressions
 * are `containerContent`'s (a query holds its post template, pager and "no results"; those
 * hold flow, columns, details and media & text, never a group or a query). `isolating` and
 * `defining` like every container. Like the atoms: attrs from the Block Spec, last writer
 * wins, and **no parse rule** (paste makes none; a copy pastes only the blocks inside).
 */
function siteContainer(type: SiteContainerType) {
  const attributes = siteBlockNodeAttrs(type, {})
  const dataType = type.replace(/_/g, "-")
  return Node.create({
    name: SITE_BLOCK_NODE_NAMES[type],
    content: containerContent(type),
    defining: true,
    isolating: true,

    addAttributes() {
      return Object.fromEntries(
        Object.entries(attributes).map(([attr, value]) => [attr, { default: value, rendered: false, parseHTML: () => null }])
      )
    },

    renderHTML({ HTMLAttributes }) {
      return ["div", mergeAttributes({ "data-type": dataType, class: "editor-site-container" }, HTMLAttributes), 0]
    },
  })
}

export const Query = siteContainer("query")
export const PostTemplate = siteContainer("post_template")
export const QueryNoResults = siteContainer("query_no_results")

/** The site blocks' commands: no schema. One ordinary transaction each (rule 7). */
export const SiteBlockCommands = Extension.create({
  name: "siteBlockCommands",
  addCommands() {
    return {
      insertSiteBlock:
        (type, attrs = {}) =>
        ({ state, commands }) => {
          const name = SITE_BLOCK_NODE_NAMES[type]
          if (!name || !state.schema.nodes[name]) return false
          return commands.insertContent(siteBlockContent(type, attrs))
        },
    }
  },
})

/**
 * Which kind of document the editor holds (design 4.2): a post's body (the default), a
 * block template or a part. Editor-only, no schema: the views read it to tell a site
 * block that works here from one that is inert in a post, and the menus read it through
 * `editorDocKind`. The Site editor (#493) configures it.
 */
export const SiteBlockContext = Extension.create<{ kind: "post" | "template" | "part" }>({
  name: "siteBlockContext",
  addOptions() {
    return { kind: "post" }
  },
  addStorage() {
    return { kind: this.options.kind }
  },
})

/** The editor's document kind: `SiteBlockContext`'s, else a post. */
export function editorDocKind(editor: { storage: unknown } | null | undefined): "post" | "template" | "part" {
  const kind = (editor?.storage as { siteBlockContext?: { kind?: unknown } } | undefined)?.siteBlockContext?.kind
  return kind === "template" || kind === "part" ? kind : "post"
}
