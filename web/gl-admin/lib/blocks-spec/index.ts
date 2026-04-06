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

export interface BaseBlock<T extends string = string, A = Record<string, unknown>> {
  id: BlockID
  type: T
  version: 1
  attrs: A
  children?: BlockID[]
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
    level: 1 | 2 | 3
    pm?: any
    text?: string
  }
>

export type BlockquoteBlock = BaseBlock<
  "blockquote",
  {
    pm?: any
    text?: string
  }
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
  }
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
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    pm: z.any().optional(),
    text: z.string().optional(),
  }),
})

export const zBlockquote = zBase.extend({
  type: z.literal("blockquote"),
  attrs: z.object({
    pm: z.any().optional(),
    text: z.string().optional(),
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

export const zImage = zBase.extend({
  type: z.literal("image"),
  attrs: z.object({
    mediaId: z.number().optional(),
    alt: z.string().optional(),
    title: z.string().optional(),
    src: z.string().optional(),
  }),
})

export const zBulletList = zBase.extend({
  type: z.literal("bullet_list"),
  attrs: z.object({}),
})

export const zOrderedList = zBase.extend({
  type: z.literal("ordered_list"),
  attrs: z.object({}),
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

// Use z.union so known types are matched first, with custom as fallback
export const zBlock = z.union([
  zParagraph,
  zHeading,
  zBlockquote,
  zCodeBlock,
  zDivider,
  zImage,
  zBulletList,
  zOrderedList,
  zListItem,
  zCustomBlock,
])

export const zBlockDocV1 = z.object({
  doc_version: z.literal(1),
  blocks_order: z.array(zBlockID),
  blocks: z.record(zBlockID, zBlock),
})

// Utility functions
export function validateBlockDoc(doc: unknown): BlockDocV1 {
  return zBlockDocV1.parse(doc)
}

export function validateBlock(block: unknown): Block {
  return zBlock.parse(block)
}
