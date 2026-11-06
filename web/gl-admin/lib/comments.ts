import type { Node as PMNode } from "prosemirror-model"
import { ApiError } from "./api/errors"
import type { CommentThread } from "./api/comments"

// Block comments (#192): the rules the editor's indicators and the comments panel share.
// Threads are anchored by the block's data-block-id (docs/design/block-map-yjs-schema.md,
// "#192: block comments"). Nothing here reads or writes the Yjs doc: the editor hands
// over the block ids it shows now, and a thread whose block isn't among them is an
// orphan (its block was deleted, joined into another, cut and pasted, or left out by a
// restore). Orphans are listed apart, never dropped, and reattach when their block comes
// back.

/** A comment's limit in characters (code points), as the API's commentBodyMax. */
export const COMMENT_BODY_MAX = 4000

/** The API's block id format (000048's CHECK, `commentBlockIDPattern`). */
const BLOCK_ID_FORMAT = /^[!-~]{10,128}$/

/** A CSS selector for the element of the block with this id (ids are printable ASCII). */
export const blockIdSelector = (id: string) => `[data-block-id="${id.replace(/["\\]/g, "\\$&")}"]`

export const isCommentableBlockId = (id: unknown): id is string => typeof id === "string" && BLOCK_ID_FORMAT.test(id)

/** A block the panel can name: its id, its type and the start of its text. */
export interface CommentBlock {
  id: string
  type: string
  text: string
}

/**
 * Every block in the doc, in document order: top-level blocks and list items (#238), the
 * nodes that carry a data-block-id.
 */
export function docBlocks(doc: PMNode): CommentBlock[] {
  const blocks: CommentBlock[] = []
  doc.descendants((node) => {
    const id = node.attrs?.["data-block-id"]
    if (typeof id === "string" && id) {
      blocks.push({ id, type: node.type.name, text: node.textContent.replace(/\s+/g, " ").trim() })
    }
    return true
  })
  return blocks
}

export interface ThreadGroups {
  /** Threads on blocks in the doc, grouped by block, in document order. */
  anchored: { block: CommentBlock; threads: CommentThread[] }[]
  /** Threads on blocks the editor can't show but the post keeps (#213, meta.dropped). */
  hidden: CommentThread[]
  /** Threads whose block isn't in the post any more. */
  orphaned: CommentThread[]
}

/** Splits threads by where their block is: in the doc, hidden, or gone. */
export function groupThreads(threads: CommentThread[], blocks: CommentBlock[], hiddenIds: ReadonlySet<string> = new Set()): ThreadGroups {
  const byBlock = new Map<string, CommentThread[]>()
  for (const thread of threads) {
    const list = byBlock.get(thread.block_id)
    if (list) list.push(thread)
    else byBlock.set(thread.block_id, [thread])
  }
  const anchored: ThreadGroups["anchored"] = []
  const seen = new Set<string>()
  for (const block of blocks) {
    const list = byBlock.get(block.id)
    if (list && !seen.has(block.id)) anchored.push({ block, threads: list })
    seen.add(block.id)
  }
  const hidden: CommentThread[] = []
  const orphaned: CommentThread[] = []
  for (const thread of threads) {
    if (seen.has(thread.block_id)) continue
    if (hiddenIds.has(thread.block_id)) hidden.push(thread)
    else orphaned.push(thread)
  }
  return { anchored, hidden, orphaned }
}

export const isOpen = (thread: CommentThread) => thread.resolved_at === null

/** Open threads per block id: the editor's indicators. */
export function openThreadCounts(threads: CommentThread[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const thread of threads) {
    if (isOpen(thread)) counts.set(thread.block_id, (counts.get(thread.block_id) ?? 0) + 1)
  }
  return counts
}

/** Keeps only the threads a filter shows ("open" or "resolved"). */
export function filterThreads(groups: ThreadGroups, filter: "open" | "resolved"): ThreadGroups {
  const keep = (thread: CommentThread) => (filter === "open" ? isOpen(thread) : !isOpen(thread))
  return {
    anchored: groups.anchored.map((g) => ({ block: g.block, threads: g.threads.filter(keep) })).filter((g) => g.threads.length > 0),
    hidden: groups.hidden.filter(keep),
    orphaned: groups.orphaned.filter(keep),
  }
}

const BLOCK_TYPE_LABELS: Record<string, string> = {
  paragraph: "Paragraph",
  heading: "Heading",
  blockquote: "Quote",
  codeBlock: "Code",
  horizontalRule: "Divider",
  image: "Image",
  bulletList: "Bulleted list",
  orderedList: "Numbered list",
  listItem: "List item",
}

const SNIPPET_MAX = 60

/** How the panel names a block: its text's start, else its kind ("Image"). */
export function blockLabel(block: Pick<CommentBlock, "type" | "text">): string {
  const text = block.text
  if (text) return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : text
  return BLOCK_TYPE_LABELS[block.type] ?? "Block"
}

/** What's wrong with a comment's text, or null: what the API refuses (400). */
export function commentBodyError(body: string): string | null {
  const trimmed = body.trim()
  if (!trimmed) return "Write a comment first"
  if ([...trimmed].length > COMMENT_BODY_MAX) return `Comments can be up to ${COMMENT_BODY_MAX.toLocaleString("en")} characters`
  return null
}

/** The message for a failed comment write. */
export function commentErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "post_trashed") return "This post is in the trash. Restore it to comment."
    if (error.code === "comment_deleted") return "That comment was deleted."
    if (error.code === "invalid_block_id") return "This block can't take comments yet. Try again in a moment."
    if (error.status === 403) return "You can't do that on this post."
    if (error.status === 404) return "That thread was deleted."
    if (error.status === 400) return error.serverMessage || "Check the comment and try again."
  }
  return "Couldn't save the comment. Try again."
}

/** "3 comments", "1 comment". */
export const commentCountLabel = (n: number) => `${n} comment${n === 1 ? "" : "s"}`
