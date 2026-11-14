import { Extension, mergeAttributes, Node } from "@tiptap/core"
import {
  SITE_BLOCK_NODE_NAMES,
  SITE_LOGO_DEFAULT_WIDTH,
  siteBlockNodeAttrs,
  type SiteBlockType,
} from "@gl-admin/lib/blocks-spec"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    siteBlocks: {
      /** A site block (#488) for the caret's line, with its default attrs. */
      insertSiteBlock: (type: SiteBlockType, attrs?: Record<string, unknown>) => ReturnType
    }
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
function siteNode(type: SiteBlockType, attributes: Record<string, unknown>) {
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

// Each node's attrs and defaults are the Block Spec's (`siteBlockNodeAttrs`): the
// fingerprint (#416) includes them, so a tab that didn't know one is refused.
export const SiteTitle = siteNode("site_title", { level: 0, link: true })
export const SiteTagline = siteNode("site_tagline", {})
export const SiteLogo = siteNode("site_logo", { width: SITE_LOGO_DEFAULT_WIDTH, link: true })
export const Navigation = siteNode("navigation", { location: null, menuId: null, layout: "row", overlay: "phone" })
export const Search = siteNode("search", { label: null, placeholder: null, button: null })
export const TemplatePart = siteNode("template_part", { slug: null })

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
          return commands.insertContent({ type: name, attrs: siteBlockNodeAttrs(type, attrs) })
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
