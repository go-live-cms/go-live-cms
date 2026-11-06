import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { getSchema } from "@tiptap/core"
import { schemaExtensions } from "./collaboration/schema"
import { ApiError } from "./api/errors"
import type { CommentThread } from "./api/comments"
import {
  blockLabel,
  COMMENT_BODY_MAX,
  commentBodyError,
  commentCountLabel,
  commentErrorMessage,
  docBlocks,
  filterThreads,
  groupThreads,
  isCommentableBlockId,
  openThreadCounts,
} from "./comments"

// The comment rules the editor and the panel share (#192).

const thread = (id: number, blockId: string, resolved = false): CommentThread => ({
  id,
  post_id: 1,
  block_id: blockId,
  created_by: null,
  created_at: "2026-11-06T10:00:00Z",
  resolved_at: resolved ? "2026-11-06T11:00:00Z" : null,
  resolved_by: null,
  can_resolve: true,
  comments: [],
})

const block = (id: string, text = id) => ({ id, type: "paragraph", text })

describe("groupThreads", () => {
  it("groups by block in document order and keeps orphans and hidden-block threads apart", () => {
    const threads = [thread(1, "blk-b"), thread(2, "blk-gone"), thread(3, "blk-a"), thread(4, "blk-b", true), thread(5, "blk-hidden")]
    const groups = groupThreads(threads, [block("blk-a"), block("blk-b"), block("blk-c")], new Set(["blk-hidden"]))
    expect(groups.anchored.map((g) => [g.block.id, g.threads.map((t) => t.id)])).toEqual([
      ["blk-a", [3]],
      ["blk-b", [1, 4]],
    ])
    expect(groups.orphaned.map((t) => t.id)).toEqual([2])
    expect(groups.hidden.map((t) => t.id)).toEqual([5])
  })

  it("a block id that appears twice anchors once (the first)", () => {
    const groups = groupThreads([thread(1, "blk-a")], [block("blk-a", "first"), block("blk-a", "second")])
    expect(groups.anchored).toHaveLength(1)
    expect(groups.anchored[0].block.text).toBe("first")
  })

  it("with no blocks reported yet, every thread is an orphan, none lost", () => {
    expect(groupThreads([thread(1, "blk-a")], []).orphaned).toHaveLength(1)
  })
})

describe("filterThreads and openThreadCounts", () => {
  const threads = [thread(1, "blk-a"), thread(2, "blk-a", true), thread(3, "blk-gone", true), thread(4, "blk-b")]
  const groups = groupThreads(threads, [block("blk-a"), block("blk-b")])

  it("Open and Resolved split threads, dropping empty groups", () => {
    const open = filterThreads(groups, "open")
    expect(open.anchored.map((g) => g.threads.map((t) => t.id))).toEqual([[1], [4]])
    expect(open.orphaned).toEqual([])
    const resolved = filterThreads(groups, "resolved")
    expect(resolved.anchored.map((g) => g.threads.map((t) => t.id))).toEqual([[2]])
    expect(resolved.orphaned.map((t) => t.id)).toEqual([3])
  })

  it("counts open threads per block for the markers", () => {
    expect([...openThreadCounts(threads)]).toEqual([
      ["blk-a", 1],
      ["blk-b", 1],
    ])
  })
})

describe("docBlocks", () => {
  it("lists top-level blocks and list items with their text, in order", () => {
    const schema = getSchema(Object.values(schemaExtensions({ collaborating: false })))
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2, "data-block-id": "blk-heading-1" }, content: [{ type: "text", text: "Title" }] },
        {
          type: "bulletList",
          attrs: { "data-block-id": "blk-list-00001" },
          content: [{ type: "listItem", attrs: { "data-block-id": "blk-item-00001" }, content: [{ type: "paragraph", content: [{ type: "text", text: "one  two" }] }] }],
        },
        { type: "horizontalRule", attrs: { "data-block-id": "blk-rule-00001" } },
      ],
    })
    expect(docBlocks(doc)).toEqual([
      { id: "blk-heading-1", type: "heading", text: "Title" },
      { id: "blk-list-00001", type: "bulletList", text: "one two" },
      { id: "blk-item-00001", type: "listItem", text: "one two" },
      { id: "blk-rule-00001", type: "horizontalRule", text: "" },
    ])
  })
})

describe("labels and messages", () => {
  it("names a block by its text, cut, else by its kind", () => {
    expect(blockLabel({ type: "paragraph", text: "Short" })).toBe("Short")
    const long = blockLabel({ type: "paragraph", text: "x".repeat(80) })
    expect(long.endsWith("…")).toBe(true)
    expect([...long].length).toBeLessThanOrEqual(60)
    expect(blockLabel({ type: "image", text: "" })).toBe("Image")
    expect(blockLabel({ type: "theme:x/y", text: "" })).toBe("Block")
  })

  it("checks a body as the API does", () => {
    expect(commentBodyError("   ")).toBe("Write a comment first")
    expect(commentBodyError("ok")).toBeNull()
    expect(commentBodyError("😀".repeat(COMMENT_BODY_MAX))).toBeNull()
    expect(commentBodyError("a".repeat(COMMENT_BODY_MAX + 1))).toMatch(/up to 4,000/)
  })

  it("maps the API's codes", () => {
    expect(commentErrorMessage(new ApiError("x", 409, null, "post_trashed"))).toMatch(/trash/)
    expect(commentErrorMessage(new ApiError("x", 409, null, "comment_deleted"))).toMatch(/deleted/)
    expect(commentErrorMessage(new ApiError("x", 403))).toMatch(/can't/)
    expect(commentErrorMessage(new ApiError("x", 404))).toMatch(/thread was deleted/)
    expect(commentErrorMessage(new Error("network"))).toMatch(/Try again/)
    expect(commentCountLabel(1)).toBe("1 comment")
    expect(commentCountLabel(3)).toBe("3 comments")
  })
})

describe("agrees with the API", () => {
  const go = readFileSync(path.resolve("../api/post_comments.go"), "utf8")
  const migration = readFileSync(path.resolve("../db/migration/000048_post_comments.up.sql"), "utf8")

  it("has the same body limit", () => {
    expect(go).toContain(`commentBodyMax = ${COMMENT_BODY_MAX}`)
    expect(migration).toContain(`char_length("body") <= ${COMMENT_BODY_MAX}`)
  })

  it("accepts the block ids the API accepts", () => {
    expect(go).toContain("regexp.MustCompile(`^[!-~]{10,128}$`)")
    expect(migration).toContain("'^[!-~]{10,128}$'")
    expect(isCommentableBlockId("blk-alpha-000001")).toBe(true)
    expect(isCommentableBlockId(crypto.randomUUID())).toBe(true)
    expect(isCommentableBlockId("short")).toBe(false)
    expect(isCommentableBlockId("has space here")).toBe(false)
    expect(isCommentableBlockId("x".repeat(129))).toBe(false)
    expect(isCommentableBlockId(null)).toBe(false)
  })
})
