import { mergeAttributes, Node } from "@tiptap/core"
import {
  attrProblem,
  THEME_BLOCK_SPEC_FIELD,
  themeBlockSpecProblem,
  type ThemeAttrSpec,
  type ThemeBlockSpec,
} from "../blocks-spec/themeBlocks"

// A theme block's headless definition (#376): its Block Spec and its TipTap node, with
// no NodeView, React or DOM, so the collab server bundles it. A theme block's `index.ts`
// default-exports one (see themes/example/blocks/Alert/index.ts and themes/README.md).

export interface ThemeBlockDefinition extends ThemeBlockSpec {
  /** Shown in the editor (slash menu, notices) and as the renderer's name. */
  title: string
  /** The TipTap node: name = `type`, attrs = the declared attrs plus `data-block-id`. */
  node: Node
  /** Its content expression, as given (`collectThemeBlocks` checks it, #414). */
  content: string
}

export interface ThemeBlockInput extends ThemeBlockSpec {
  title: string
  /**
   * The node's ProseMirror content expression, over core node types and groups only (a
   * theme block is one node). Default `"inline*"`; `""` makes it a leaf (attrs only).
   * Text only (#414, `THEME_BLOCK_CONTENT_NAMES`): no `block`, list, quote, image or
   * container, so no block or media can hide inside a theme block's `pm`.
   */
  content?: string
  /** The marks allowed inside it (ProseMirror `marks`); default: all. */
  marks?: string
}

const dataAttr = (name: string) => `data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`

/** An attr value read from HTML (a paste), or null when it isn't a valid value. */
function parseAttr(attr: ThemeAttrSpec, raw: string | null): unknown {
  if (raw === null) return null
  const value = attr.type === "number" ? Number(raw) : attr.type === "boolean" ? raw === "true" : raw
  return attrProblem(attr, value) === null ? value : null
}

export function defineThemeBlock(input: ThemeBlockInput): ThemeBlockDefinition {
  const { title, content = "inline*", marks, ...specInput } = input
  const spec: ThemeBlockSpec = { type: specInput.type, version: specInput.version, attrs: specInput.attrs }
  const problem = themeBlockSpecProblem(spec)
  if (problem) throw new Error(`theme block: ${problem}`)
  const leaf = content === ""

  const node = Node.create({
    name: spec.type,
    group: "block",
    content,
    ...(marks !== undefined ? { marks } : {}),
    ...(leaf ? { atom: true } : {}),
    defining: true,

    addAttributes() {
      const declared = Object.fromEntries(
        Object.entries(spec.attrs).map(([name, attr]) => [
          name,
          {
            default: attr.default,
            parseHTML: (element: HTMLElement) => parseAttr(attr, element.getAttribute(dataAttr(name))) ?? attr.default,
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes[name] === null || attributes[name] === undefined ? {} : { [dataAttr(name)]: String(attributes[name]) },
          },
        ]),
      )
      return {
        ...declared,
        "data-block-id": {
          default: null,
          parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id"),
          renderHTML: (attributes: Record<string, unknown>) =>
            attributes["data-block-id"] ? { "data-block-id": attributes["data-block-id"] } : {},
        },
      }
    },

    parseHTML() {
      return [{ tag: `div[data-block-type="${spec.type}"]` }]
    },

    renderHTML({ HTMLAttributes }) {
      const attrs = mergeAttributes({ "data-block-type": spec.type }, HTMLAttributes)
      return leaf ? ["div", attrs] : ["div", attrs, 0]
    },

    // Puts the spec on this node's own NodeSpec, so code that only has the schema (the
    // bridge, the collab server's store validation) knows the node is a theme block and
    // which version and attrs it has. TipTap calls this for every node; only ours gets it.
    extendNodeSchema(extension) {
      return extension.name === spec.type ? { [THEME_BLOCK_SPEC_FIELD]: spec } : {}
    },
  })

  return { ...spec, title, node, content }
}