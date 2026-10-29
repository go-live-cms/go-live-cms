import { z } from "zod"

// Block Spec v1 - Authoritative Types
export type BlockID = string

/** Well-known block types built into the editor */
export type KnownBlockType =
  | "paragraph"
  | "heading"
  | "blockquote"
  | "code_block"
  | "divider"
  | "image"
  | "bullet_list"
  | "ordered_list"
  | "list_item"

/** BlockType allows known types + arbitrary custom types from themes */
export type BlockType = KnownBlockType | (string & {})

export interface BaseBlock<T extends string = string, A = Record<string, unknown>, V extends number = 1> {
  id: BlockID
  type: T
  /** The block's attrs version. Only image and blockquote have a v2 (#346). */
  version: V
  attrs: A
  children?: BlockID[]
}

/**
 * Block versions the editor writes (#346). Image v2 adds `caption` and `align`,
 * blockquote v2 adds `cite`. Readers accept v1 and v2, with or without the new attrs:
 * a missing attr means its default, so an old block renders exactly as before.
 */
export const IMAGE_BLOCK_VERSION = 2
export const BLOCKQUOTE_BLOCK_VERSION = 2

/** Image widths (#346): the content column, the theme's `wideWidth`, full bleed. */
export const IMAGE_ALIGNS = ["inline", "wide", "full"] as const
export type ImageAlign = (typeof IMAGE_ALIGNS)[number]

export function isImageAlign(value: unknown): value is ImageAlign {
  return typeof value === "string" && (IMAGE_ALIGNS as readonly string[]).includes(value)
}

/** The marks a caption may carry, here and in the API sanitizer (`captionMarks`). */
export const CAPTION_MARKS = ["bold", "italic", "link"] as const

/** Longest quote citation, in code points (runes in the API's sanitizer). */
export const CITE_MAX_LENGTH = 300

/** At most CITE_MAX_LENGTH code points (an editor field's maxLength counts UTF-16 units). */
export function capCite(value: string): string {
  const points = [...value]
  return points.length > CITE_MAX_LENGTH ? points.slice(0, CITE_MAX_LENGTH).join("") : value
}

/**
 * A citation as stored, exactly as the API sanitizer makes it: control characters as
 * spaces, trimmed, at most CITE_MAX_LENGTH code points, null when empty.
 */
export function normalizeCite(value: unknown): string | null {
  if (typeof value !== "string") return null
  const cite = capCite(value.replace(/\p{Cc}/gu, " ").trim()).trim()
  return cite === "" ? null : cite
}

/**
 * A caption's runs as they may be shown or stored: non-empty text runs with only the
 * caption marks. Used by the bridge and the public renderer.
 */
export function captionRuns(caption: unknown): CaptionText[] {
  if (!Array.isArray(caption)) return []
  const allowed = new Set<string>(CAPTION_MARKS)
  return caption
    .filter((run) => run?.type === "text" && typeof run.text === "string" && run.text !== "")
    .map((run): CaptionText => {
      const marks = Array.isArray(run.marks) ? run.marks.filter((mark: any) => allowed.has(mark?.type)) : []
      return marks.length > 0 ? { type: "text", text: run.text, marks } : { type: "text", text: run.text }
    })
}

/**
 * One run of caption text: the `imageCaption` node's content (`text*`) as ProseMirror
 * JSON. Only bold, italic and link marks.
 */
export interface CaptionText {
  type: "text"
  text: string
  marks?: { type: (typeof CAPTION_MARKS)[number]; attrs?: Record<string, unknown> }[]
}

export type ParagraphBlock = BaseBlock<
  "paragraph",
  {
    pm?: any
    text?: string
  }
>

export type HeadingBlock = BaseBlock<
  "heading",
  {
    // Editor allows h1-h6 (StarterKit heading levels [1..6] in
    // editor/utils/extensions.ts); keep zHeading below in sync.
    level: 1 | 2 | 3 | 4 | 5 | 6
    pm?: any
    text?: string
  }
>

export type BlockquoteBlock = BaseBlock<
  "blockquote",
  {
    pm?: any
    text?: string
    /** Plain-text attribution, rendered as `<cite>`. Absent: none. */
    cite?: string
  },
  1 | 2
>

export type CodeBlock = BaseBlock<
  "code_block",
  {
    language?: string
    code: string
  }
>

export type DividerBlock = BaseBlock<"divider", {}>

export type ImageBlock = BaseBlock<
  "image",
  {
    mediaId?: number
    alt?: string
    title?: string
    src?: string
    /** Rich caption (bold, italic, link). Absent: no caption. */
    caption?: CaptionText[]
    /** Absent: "inline". */
    align?: ImageAlign
  },
  1 | 2
>

export type BulletListBlock = BaseBlock<"bullet_list", {}>

export type OrderedListBlock = BaseBlock<"ordered_list", {}>

export type ListItemBlock = BaseBlock<
  "list_item",
  {
    pm?: any
    text?: string
  }
>

/**
 * Custom block type for theme-defined blocks (e.g., alert, callout, etc.)
 * Preserves the full ProseMirror JSON for round-trip fidelity.
 */
export type CustomBlock = BaseBlock<
  string,
  {
    pm?: any
    text?: string
    [key: string]: unknown
  }
>

export type Block =
  | ParagraphBlock
  | HeadingBlock
  | BlockquoteBlock
  | CodeBlock
  | DividerBlock
  | ImageBlock
  | BulletListBlock
  | OrderedListBlock
  | ListItemBlock
  | CustomBlock

export interface BlockDocV1 {
  doc_version: 1 // spec version
  blocks_order: BlockID[]
  blocks: Record<BlockID, Block>
}

export const zBlockID = z.string().min(10) // ULID/UUID

const zBase = z.object({
  id: zBlockID,
  version: z.literal(1),
})

export const zParagraph = zBase.extend({
  type: z.literal("paragraph"),
  attrs: z.object({
    pm: z.any().optional(),
    text: z.string().optional(),
  }),
})

export const zHeading = zBase.extend({
  type: z.literal("heading"),
  attrs: z.object({
    level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
    pm: z.any().optional(),
    text: z.string().optional(),
  }),
})

// Image and blockquote have a v2 (#346); readers take both.
const zVersion1or2 = z.union([z.literal(1), z.literal(2)])

export const zBlockquote = zBase.extend({
  type: z.literal("blockquote"),
  version: zVersion1or2,
  attrs: z.object({
    pm: z.any().optional(),
    text: z.string().optional(),
    cite: z
      .string()
      .refine((cite) => [...cite].length <= CITE_MAX_LENGTH, `at most ${CITE_MAX_LENGTH} characters`)
      .optional(),
  }),
})

export const zCodeBlock = zBase.extend({
  type: z.literal("code_block"),
  attrs: z.object({
    language: z.string().optional(),
    code: z.string(),
  }),
})

export const zDivider = zBase.extend({
  type: z.literal("divider"),
  attrs: z.object({}),
})

export const zCaptionText = z.object({
  type: z.literal("text"),
  // ProseMirror has no empty text nodes.
  text: z.string().min(1),
  marks: z
    .array(
      z.object({
        type: z.enum(CAPTION_MARKS),
        attrs: z.record(z.unknown()).optional(),
      }),
    )
    .optional(),
})

export const zImage = zBase.extend({
  type: z.literal("image"),
  version: zVersion1or2,
  attrs: z.object({
    mediaId: z.number().optional(),
    alt: z.string().optional(),
    title: z.string().optional(),
    src: z.string().optional(),
    caption: z.array(zCaptionText).optional(),
    align: z.enum(IMAGE_ALIGNS).optional(),
  }),
})

export const zBulletList = zBase.extend({
  type: z.literal("bullet_list"),
  attrs: z.object({}),
  children: z.array(zBlockID).optional(),
})

export const zOrderedList = zBase.extend({
  type: z.literal("ordered_list"),
  attrs: z.object({}),
  children: z.array(zBlockID).optional(),
})

export const zListItem = zBase.extend({
  type: z.literal("list_item"),
  attrs: z.object({
    pm: z.any().optional(),
    text: z.string().optional(),
  }),
})

/** Catch-all for theme/custom block types not in the known set */
export const zCustomBlock = zBase.extend({
  type: z.string(),
  attrs: z.record(z.unknown()),
  children: z.array(zBlockID).optional(),
})

const knownBlockSchemas: Record<KnownBlockType, z.ZodTypeAny> = {
  paragraph: zParagraph,
  heading: zHeading,
  blockquote: zBlockquote,
  code_block: zCodeBlock,
  divider: zDivider,
  image: zImage,
  bullet_list: zBulletList,
  ordered_list: zOrderedList,
  list_item: zListItem,
}

// A known type must match its own schema; only other types fall back to the custom
// catch-all. (A plain z.union let a malformed known block, e.g. a heading with
// level 7, pass as a "custom" block, #214.) The input comes back unchanged: the
// object schemas would strip keys they don't list, and the collab server stores
// what it validated (#206).
export const zBlock = z.unknown().superRefine((value, ctx) => {
  const type = (value as { type?: unknown } | null)?.type
  const schema =
    typeof type === "string" && Object.prototype.hasOwnProperty.call(knownBlockSchemas, type)
      ? knownBlockSchemas[type as KnownBlockType]
      : zCustomBlock
  const result = schema.safeParse(value)
  if (!result.success) result.error.issues.forEach((issue) => ctx.addIssue(issue))
}) as unknown as z.ZodType<Block>

export const zBlockDocV1 = z
  .object({
    doc_version: z.literal(1),
    blocks_order: z.array(zBlockID),
    blocks: z.record(zBlockID, zBlock),
  })
  .superRefine((doc, ctx) => {
    for (const [key, block] of Object.entries(doc.blocks)) {
      // This runs even when a block already failed its own schema, so it may be null.
      const blockId = (block as { id?: unknown } | null)?.id
      if (blockId !== undefined && blockId !== key) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["blocks", key, "id"], message: "block id must equal its map key" })
      }
    }
  })

// Utility functions. Both throw a ZodError on invalid input and otherwise return the
// input itself, never a stripped copy.
export function validateBlockDoc(doc: unknown): BlockDocV1 {
  zBlockDocV1.parse(doc)
  return doc as BlockDocV1
}

export function validateBlock(block: unknown): Block {
  zBlock.parse(block)
  return block as Block
}
