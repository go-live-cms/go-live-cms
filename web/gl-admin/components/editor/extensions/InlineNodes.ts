import { mergeAttributes, Node, type Range } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import {
  CONTENT_LINK_NODE,
  DATE_CHIP_NODE,
  dateChipAttrs,
  MENTION_NODE,
  normalizeChipDate,
  normalizeChipTime,
  normalizeEntityId,
  normalizeInlineLabel,
  normalizeReminder,
  type ContentLinkAttrs,
  type DateChipAttrs,
  type MentionAttrs,
} from "@gl-admin/lib/blocks-spec/inlineNodes"
import { formatDateChip } from "@/lib/dateChips"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    inlineNodes: {
      /** Replace `range` (the typed "@query") with a mention and a space (the @ menu, #320). */
      insertMention: (attrs: MentionAttrs, range?: Range) => ReturnType
      /** Replace `range` with a link to a post or page and a space. */
      insertContentLink: (attrs: ContentLinkAttrs, range?: Range) => ReturnType
      /** Replace `range` with a date chip (a reminder when `reminder`) and a space. */
      insertDateChip: (attrs: DateChipAttrs, range?: Range) => ReturnType
    }
  }
}

/**
 * The inline nodes of #320 (Block Spec rules in `blocks-spec/inlineNodes.ts`): `mention`,
 * `contentLink` and `dateChip`. Each is an inline **atom** (one character for the caret,
 * deleted as a whole, never edited inside), so two people can't type into it and its
 * attrs are all it holds; last writer wins on them, like any node attribute.
 *
 * Schema only (no DOM code), so the collab server builds the same schema (`schema.ts`).
 * They change the schema fingerprint (#416): a tab from before #320 is refused at its
 * reconnect instead of deleting them (rule 10). The editor's views (the member's current
 * name, the site's date format) are `InlineNodeViews.ts`.
 *
 * HTML (the editor's own clipboard, and what paste keeps, `PasteSanitizer.ts`):
 * `<span data-type="mention" data-user-id data-label>@Name</span>`,
 * `<span data-type="content-link" data-post-id data-label>Title</span>`,
 * `<span data-type="date" data-date data-time data-reminder>Nov 12, 2026</span>`.
 * Every value is checked by the shared normalizers; a span without a valid id or date
 * isn't one of these nodes (its text is pasted as text).
 *
 * `leafText` (through `extendNodeSchema`) is what `textContent` gives for them, so the
 * block's plain `text` attr, search and the character count read "@Ana Costa", the link
 * text and the date.
 */

const span = (type: string) => `span[data-type="${type}"]`

function insertInline(type: string, attrs: Record<string, unknown>, range: Range | undefined) {
  return ({ chain, state }: { chain: () => any; state: any }) => {
    const at = range ?? { from: state.selection.from, to: state.selection.to }
    return chain()
      .insertContentAt(at, [{ type, attrs }, { type: "text", text: " " }])
      .run()
  }
}

export const Mention = Node.create({
  name: MENTION_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      userId: {
        default: null,
        parseHTML: (element) => normalizeEntityId(element.getAttribute("data-user-id")),
        renderHTML: (attributes) => (attributes.userId ? { "data-user-id": String(attributes.userId) } : {}),
      },
      label: {
        default: null,
        parseHTML: (element) => normalizeInlineLabel(element.getAttribute("data-label") ?? element.textContent?.replace(/^@/, "")),
        renderHTML: (attributes) => (attributes.label ? { "data-label": attributes.label } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: span("mention"), getAttrs: (element) => (normalizeEntityId((element as HTMLElement).getAttribute("data-user-id")) === null ? false : null) }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes({ "data-type": "mention", class: "editor-mention" }, HTMLAttributes), mentionText(node)]
  },

  renderText({ node }) {
    return mentionText(node)
  },

  extendNodeSchema(extension) {
    return extension.name === MENTION_NODE ? { leafText: mentionText } : {}
  },

  addCommands() {
    return {
      insertMention: (attrs, range) => insertInline(MENTION_NODE, { userId: attrs.userId, label: normalizeInlineLabel(attrs.label) }, range),
    }
  },
})

export const ContentLink = Node.create({
  name: CONTENT_LINK_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      postId: {
        default: null,
        parseHTML: (element) => normalizeEntityId(element.getAttribute("data-post-id")),
        renderHTML: (attributes) => (attributes.postId ? { "data-post-id": String(attributes.postId) } : {}),
      },
      label: {
        default: null,
        parseHTML: (element) => normalizeInlineLabel(element.getAttribute("data-label") ?? element.textContent),
        renderHTML: (attributes) => (attributes.label ? { "data-label": attributes.label } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: span("content-link"), getAttrs: (element) => (normalizeEntityId((element as HTMLElement).getAttribute("data-post-id")) === null ? false : null) }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes({ "data-type": "content-link", class: "editor-content-link" }, HTMLAttributes), contentLinkText(node)]
  },

  renderText({ node }) {
    return contentLinkText(node)
  },

  extendNodeSchema(extension) {
    return extension.name === CONTENT_LINK_NODE ? { leafText: contentLinkText } : {}
  },

  addCommands() {
    return {
      insertContentLink: (attrs, range) => insertInline(CONTENT_LINK_NODE, { postId: attrs.postId, label: normalizeInlineLabel(attrs.label) }, range),
    }
  },
})

export const DateChip = Node.create({
  name: DATE_CHIP_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      date: {
        default: null,
        parseHTML: (element) => normalizeChipDate(element.getAttribute("data-date")),
        renderHTML: (attributes) => (attributes.date ? { "data-date": attributes.date } : {}),
      },
      time: {
        default: null,
        parseHTML: (element) => normalizeChipTime(element.getAttribute("data-time")),
        renderHTML: (attributes) => (attributes.time ? { "data-time": attributes.time } : {}),
      },
      reminder: {
        default: false,
        parseHTML: (element) => normalizeReminder(element.getAttribute("data-reminder")),
        renderHTML: (attributes) => (attributes.reminder ? { "data-reminder": "true" } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: span("date"), getAttrs: (element) => (normalizeChipDate((element as HTMLElement).getAttribute("data-date")) === null ? false : null) }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes({ "data-type": "date", class: "editor-date-chip" }, HTMLAttributes), dateChipText(node)]
  },

  renderText({ node }) {
    return dateChipText(node)
  },

  extendNodeSchema(extension) {
    return extension.name === DATE_CHIP_NODE ? { leafText: dateChipText } : {}
  },

  addCommands() {
    return {
      insertDateChip: (attrs, range) => {
        const clean = dateChipAttrs(attrs as unknown as Record<string, unknown>)
        if (!clean) return () => false
        return insertInline(DATE_CHIP_NODE, { ...clean }, range)
      },
    }
  },
})

/** "@Ana Costa" (the stored label; the editor's view shows the current name). */
export function mentionText(node: PMNode): string {
  return `@${node.attrs.label ?? "member"}`
}

export function contentLinkText(node: PMNode): string {
  return node.attrs.label ?? "Untitled"
}

/** The chip as plain text, in the default format (the editor's view uses the site's). */
export function dateChipText(node: PMNode): string {
  const attrs = dateChipAttrs(node.attrs)
  return attrs ? formatDateChip(attrs) : ""
}
