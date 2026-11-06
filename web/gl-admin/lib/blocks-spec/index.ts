import { z } from "zod"
import { isThemeBlockType, themeBlockIssues, type ThemeBlockLookup } from "./themeBlocks"
import { nestingIssues } from "./nesting"

export * from "./nesting"

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
  | "group"
  | "table"

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

/**
 * Group (#414), the first container (`nesting.ts`): blocks kept together, optionally on
 * the theme's surface colour (`tinted`), at the content, wide or full width. Defaults
 * (`none`, `content`) are left out of the stored block.
 */
export const GROUP_STYLES = ["none", "tinted"] as const
export type GroupStyle = (typeof GROUP_STYLES)[number]
export const GROUP_ALIGNS = ["content", "wide", "full"] as const
export type GroupAlign = (typeof GROUP_ALIGNS)[number]

export function isGroupStyle(value: unknown): value is GroupStyle {
  return typeof value === "string" && (GROUP_STYLES as readonly string[]).includes(value)
}

export function isGroupAlign(value: unknown): value is GroupAlign {
  return typeof value === "string" && (GROUP_ALIGNS as readonly string[]).includes(value)
}

/**
 * Table (#420), a flow block: one block whose rows are in `attrs.pm` (the `table` node's
 * JSON: `tableRow`s of `tableCell`s, each cell `paragraph+`, nothing else), whether its
 * first row is a header row in `attrs.headerRow` (canonical: the stored cells are all
 * `tableCell`), and its caption as runs in `attrs.caption`, like an image's.
 *
 * A cell's `colspan` and `rowspan` are its only attrs, integers clamped to
 * 1..TABLE_MAX_SPAN, stored only when not 1 (here, in the bridge and in the API's
 * sanitizer, `tableMaxSpan`). The size picker makes at most TABLE_MAX_COLUMNS columns and
 * TABLE_MAX_ROWS rows; a pasted table may be bigger.
 */
export const TABLE_MAX_SPAN = 64
export const TABLE_MAX_COLUMNS = 20
export const TABLE_MAX_ROWS = 100
/** The cell node types a stored table's pm may name; a `tableHeader` is read as a plain cell (the header row is `headerRow`). */
export const TABLE_CELL_TYPES = ["tableCell", "tableHeader"] as const

/** A cell span as stored: an integer in 1..TABLE_MAX_SPAN (a non-number is 1). */
export function clampTableSpan(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN
  if (!Number.isFinite(n)) return 1
  return Math.min(TABLE_MAX_SPAN, Math.max(1, Math.floor(n)))
}

/** One cell of a stored table, as the renderer reads it. */
export interface TableCellView {
  colspan: number
  rowspan: number
  /** The cell's paragraphs, as ProseMirror JSON. */
  content: any[]
}

/**
 * A stored table's rows as the public renderer and the history read them: every row that
 * is a `tableRow`, every cell of a cell type, its spans clamped and its paragraphs (only
 * paragraphs: anything else a bad write put there is left out). A cell with none keeps one
 * empty paragraph. A row with no cells stays (a rowspan above covers it); a table with no
 * rows is left out.
 */
export function tableRows(pm: unknown): TableCellView[][] {
  const rows = (pm as { type?: unknown; content?: unknown } | null)?.type === "table" ? (pm as { content?: unknown }).content : null
  if (!Array.isArray(rows)) return []
  const cellTypes = new Set<string>(TABLE_CELL_TYPES)
  return rows
    .filter((row) => row?.type === "tableRow" && Array.isArray(row.content))
    .map((row) =>
      (row.content as any[])
        .filter((cell) => cellTypes.has(cell?.type))
        .map((cell): TableCellView => {
          const paragraphs = Array.isArray(cell.content) ? cell.content.filter((node: any) => node?.type === "paragraph") : []
          return {
            colspan: clampTableSpan(cell.attrs?.colspan),
            rowspan: clampTableSpan(cell.attrs?.rowspan),
            content: paragraphs.length > 0 ? paragraphs : [{ type: "paragraph" }],
          }
        }),
    )
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
 * Block colour (#356): a fixed palette of theme tokens, never a free colour. A block is
 * either tinted text (`"red"`) or a tinted background (`"red-background"`), not both:
 * every theme only has to make each token readable on its own page background (text) and
 * with its own text colour (background), so no pair a writer picks can fail contrast.
 * Every theme in `themes/` styles `.gl-color-<value>` in light and dark; the editor uses
 * the admin's `--block-*` tokens.
 */
export const BLOCK_COLOR_TOKENS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const
export type BlockColorToken = (typeof BLOCK_COLOR_TOKENS)[number]
export const BLOCK_COLORS = [
  ...BLOCK_COLOR_TOKENS,
  ...BLOCK_COLOR_TOKENS.map((token) => `${token}-background` as const),
] as const
export type BlockColor = (typeof BLOCK_COLORS)[number]
/** The block types that take a colour: their `attrs.blockColor`. */
export const COLORABLE_BLOCK_TYPES = ["paragraph", "heading", "blockquote", "bullet_list", "ordered_list"] as const

export function isBlockColor(value: unknown): value is BlockColor {
  return typeof value === "string" && (BLOCK_COLORS as readonly string[]).includes(value)
}

/** A stored or pasted colour as the palette has it; anything else (a hex, an unknown token) is null. */
export function normalizeBlockColor(value: unknown): BlockColor | null {
  return isBlockColor(value) ? value : null
}

/**
 * The public element id of a top-level block (#356, "Copy link to block"): `b-<id>`, on
 * every top-level block the public renderer outputs. Null for an id that isn't safe in
 * an HTML id and a URL fragment as is (stored ids are UUIDs; anything else gets no
 * anchor rather than a broken one). Heading ids (#351) never take one of these.
 */
export function blockAnchorId(blockId: unknown): string | null {
  return typeof blockId === "string" && /^[A-Za-z0-9_-]{10,128}$/.test(blockId) ? `b-${blockId}` : null
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
    /** #356. Absent: the theme's text colour. */
    blockColor?: BlockColor
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
    blockColor?: BlockColor
  }
>

export type BlockquoteBlock = BaseBlock<
  "blockquote",
  {
    pm?: any
    text?: string
    /** Plain-text attribution, rendered as `<cite>`. Absent: none. */
    cite?: string
    blockColor?: BlockColor
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

export type BulletListBlock = BaseBlock<"bullet_list", { blockColor?: BlockColor }>

export type OrderedListBlock = BaseBlock<"ordered_list", { blockColor?: BlockColor }>

export type ListItemBlock = BaseBlock<
  "list_item",
  {
    pm?: any
    text?: string
  }
>

/** A container (#414): `children` are its blocks, flow types only (`nesting.ts`). */
export type GroupBlock = BaseBlock<
  "group",
  {
    /** Absent: "none". */
    style?: GroupStyle
    /** Absent: "content". */
    align?: GroupAlign
  }
>

/** A table (#420), a flow block: its rows in `pm`, never `children`. */
export type TableBlock = BaseBlock<
  "table",
  {
    /** The `table` node: `tableRow`s of `tableCell`s with `paragraph+` (see TABLE_MAX_SPAN). */
    pm: any
    /** Cell texts, a space between cells and a newline between rows. */
    text?: string
    /** The first row is a header row. Absent: no header row. */
    headerRow?: true
    /** Rich caption (bold, italic, link). Absent: no caption. */
    caption?: CaptionText[]
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
  },
  // A theme block's version is its theme's (#376).
  number
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
  | GroupBlock
  | TableBlock
  | CustomBlock

export interface BlockDocV1 {
  doc_version: 1 // spec version
  blocks_order: BlockID[]
  blocks: Record<BlockID, Block>
}

export const zBlockID = z.string().min(10) // ULID/UUID

// The bridge and the API's sanitizer leave an unknown colour out, so a stored one is
// always in the palette.
const zBlockColor = z.enum(BLOCK_COLORS).optional()

const zBase = z.object({
  id: zBlockID,
  version: z.literal(1),
})

export const zParagraph = zBase.extend({
  type: z.literal("paragraph"),
  attrs: z.object({
    pm: z.any().optional(),
    text: z.string().optional(),
    blockColor: zBlockColor,
  }),
})

export const zHeading = zBase.extend({
  type: z.literal("heading"),
  attrs: z.object({
    level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
    pm: z.any().optional(),
    text: z.string().optional(),
    blockColor: zBlockColor,
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
    blockColor: zBlockColor,
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
  attrs: z.object({ blockColor: zBlockColor }),
  children: z.array(zBlockID).optional(),
})

export const zOrderedList = zBase.extend({
  type: z.literal("ordered_list"),
  attrs: z.object({ blockColor: zBlockColor }),
  children: z.array(zBlockID).optional(),
})

export const zListItem = zBase.extend({
  type: z.literal("list_item"),
  attrs: z.object({
    pm: z.any().optional(),
    text: z.string().optional(),
  }),
})

export const zGroup = zBase.extend({
  type: z.literal("group"),
  attrs: z.object({
    style: z.enum(GROUP_STYLES).optional(),
    align: z.enum(GROUP_ALIGNS).optional(),
  }),
  // Count and child types are the nesting table's (nestingIssues).
  children: z.array(zBlockID),
})

// A table's pm (#420): rows of cells of paragraphs. The cells' only attrs are their spans
// (`.strict()`: the bridge writes nothing else, the API keeps nothing else).
const zTableSpan = z.number().int().min(2).max(TABLE_MAX_SPAN)
const zTableCell = z.object({
  type: z.enum(TABLE_CELL_TYPES),
  attrs: z.object({ colspan: zTableSpan.optional(), rowspan: zTableSpan.optional() }).strict().optional(),
  content: z.array(z.object({ type: z.literal("paragraph") }).passthrough()).min(1),
})
// A row may have no cells of its own (every one covered by a rowspan from above).
const zTableRow = z.object({
  type: z.literal("tableRow"),
  content: z.array(zTableCell),
})

export const zTable = zBase.extend({
  type: z.literal("table"),
  attrs: z.object({
    pm: z.object({ type: z.literal("table"), content: z.array(zTableRow).min(1) }),
    text: z.string().optional(),
    headerRow: z.literal(true).optional(),
    caption: z.array(zCaptionText).optional(),
  }),
})

/**
 * Catch-all for theme/custom block types not in the known set. Any version: a theme
 * block keeps the version its theme wrote even when that theme isn't installed here.
 * An installed theme block is also checked against its spec (validateBlockDoc).
 */
export const zCustomBlock = zBase.extend({
  type: z.string(),
  version: z.number().int().positive(),
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
  group: zGroup,
  table: zTable,
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

export interface ValidateOptions {
  /**
   * The installed theme blocks (#376), e.g. `themeBlockLookup(schema)`. A block of one of
   * them must also match its spec: a version this build reads, valid declared attrs.
   */
  themeBlocks?: ThemeBlockLookup
}

// Utility functions. Both throw a ZodError on invalid input and otherwise return the
// input itself, never a stripped copy.
export function validateBlockDoc(doc: unknown, { themeBlocks }: ValidateOptions = {}): BlockDocV1 {
  zBlockDocV1.parse(doc)
  // How blocks nest (#414, design 2.3): references, one parent each, no cycles, what each
  // container holds. The same checks as the API's (nestingVectors.json). Repeats within
  // one list are not an error here only after `dedupeBlockRefs`, which the store runs first.
  const issues: z.ZodIssue[] = nestingIssues(doc).map((issue) => ({ code: z.ZodIssueCode.custom, ...issue }))
  if (themeBlocks) {
    for (const [key, block] of Object.entries((doc as BlockDocV1).blocks)) {
      const spec = isThemeBlockType(block.type) ? themeBlocks(block.type) : undefined
      if (!spec) continue
      for (const issue of themeBlockIssues(spec, block)) {
        issues.push({ code: z.ZodIssueCode.custom, path: ["blocks", key, ...issue.path], message: issue.message })
      }
    }
  }
  if (issues.length > 0) throw new z.ZodError(issues)
  return doc as BlockDocV1
}

export function validateBlock(block: unknown): Block {
  zBlock.parse(block)
  return block as Block
}
