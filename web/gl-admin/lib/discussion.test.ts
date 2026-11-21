import { describe, expect, it } from "vitest"
import type { ModerationComment } from "@gl-admin/lib/api/discussion"
import {
  bulkActionsFor,
  bulkReport,
  canReplyTo,
  commentLabel,
  commenterLine,
  deleteConfirm,
  discussionLine,
  discussionNavLabel,
  emptyQueue,
  eraseConfirm,
  erasedMessage,
  excerpt,
  exportFileName,
  findDiscussionTab,
  networkLine,
  pendingAttention,
  phoneActions,
  reasonLabel,
  replyButton,
  replyHint,
  replyLabel,
  rowActions,
  selectionAfterBulk,
  threadPill,
  trashLines,
} from "./discussion"

function comment(overrides: Partial<ModerationComment> = {}): ModerationComment {
  return {
    id: 1,
    parent_id: null,
    root_id: null,
    status: "pending",
    trashed_from: null,
    held_reason: "first_comment",
    held_detail: null,
    name: "Maya Lindqvist",
    badge: null,
    avatar: null,
    author_user_id: null,
    commenter: { id: 7, email: "maya@example.com", new: true, blocked: false },
    body: "We tried this with three editors.",
    replying_to: "",
    notify_replies: false,
    edited: false,
    removed: false,
    created_at: "2026-11-20T10:00:00Z",
    approved_at: null,
    moderated_at: null,
    moderated_by: "",
    post: { id: 3, title: "Shipping", post_type: "post", status: "published", url: "/post/shipping" },
    ...overrides,
  }
}

describe("tabs and actions (16.1)", () => {
  it("opens on Pending and falls back to it", () => {
    expect(findDiscussionTab(null).id).toBe("pending")
    expect(findDiscussionTab("spam").id).toBe("spam")
    expect(findDiscussionTab("unconfirmed").id).toBe("pending")
  })

  it("offers each status its row actions", () => {
    expect(rowActions(comment(), 5)).toEqual(["approve", "spam", "trash", "reply"])
    expect(rowActions(comment({ status: "approved" }), 5)).toEqual(["unapprove", "spam", "trash", "reply"])
    expect(rowActions(comment({ status: "spam" }), 5)).toEqual(["not_spam", "delete"])
    expect(rowActions(comment({ status: "trash" }), 5)).toEqual(["restore", "delete"])
    expect(rowActions(comment({ status: "approved", removed: true }), 5)).toEqual([])
  })

  it("puts Edit first on your own comment only (decision 9: never a reader's)", () => {
    const own = comment({ status: "approved", author_user_id: 5, commenter: null, badge: "author" })
    expect(rowActions(own, 5)[0]).toBe("edit")
    expect(rowActions(own, 6)).not.toContain("edit")
    expect(rowActions(comment({ status: "approved" }), 5)).not.toContain("edit")
  })

  it("keeps Approve and Spam on a phone, the rest behind More, no reply", () => {
    expect(phoneActions(comment())).toEqual({ primary: ["approve", "spam"], more: ["trash"] })
    expect(phoneActions(comment({ status: "spam" }))).toEqual({ primary: ["not_spam", "delete"], more: [] })
  })

  it("gives each tab its bulk actions", () => {
    expect(bulkActionsFor("pending")).toEqual(["approve", "spam", "trash"])
    expect(bulkActionsFor("approved")).toEqual(["unapprove", "spam", "trash"])
    expect(bulkActionsFor("spam")).toEqual(["not_spam", "delete"])
    expect(bulkActionsFor("trash")).toEqual(["restore", "delete"])
  })
})

describe("reasons (4.2, 16.1, 16.2)", () => {
  it("says why a comment is held", () => {
    expect(reasonLabel(comment())).toBe("First comment")
    expect(reasonLabel(comment({ held_reason: "moderation_all" }))).toBe("Every comment is held")
    expect(reasonLabel(comment({ held_reason: "member_name" }))).toBe("Name matches a member")
    expect(reasonLabel(comment({ held_reason: "held_word", held_detail: "refund" }))).toBe("Held word: refund")
    expect(reasonLabel(comment({ held_reason: "previous_spam" }))).toBe("Marked spam before")
    expect(reasonLabel(comment({ held_reason: "plugin", held_detail: "Spam check" }))).toBe("Plugin: Spam check")
    expect(
      reasonLabel(comment({ held_reason: "links", body: "See https://a.example/x, https://b.example and https://c.example" }))
    ).toBe("3 links · over the limit")
    expect(reasonLabel(comment({ held_reason: null }))).toBeNull()
  })

  it("says why a comment is in spam", () => {
    const spam = (held_reason: string, extra: Partial<ModerationComment> = {}) => reasonLabel(comment({ status: "spam", held_reason, ...extra }))
    expect(spam("spam_word", { held_detail: "replica" })).toBe("Spam word: replica")
    expect(spam("honeypot")).toBe("Filled the hidden field")
    expect(spam("plugin", { held_detail: "Spam check" })).toBe("Plugin: Spam check")
    expect(spam("blocked")).toBe("Blocked commenter")
    expect(spam("moderator", { moderated_by: "Ana Costa" })).toBe("Marked by Ana Costa")
  })

  it("says nothing for approved and trash, and pills held ones in a thread", () => {
    expect(reasonLabel(comment({ status: "approved" }))).toBeNull()
    expect(threadPill(comment())).toEqual({ label: "Pending · First comment", tone: "warning" })
    expect(threadPill(comment({ status: "spam", held_reason: "plugin", held_detail: "Spam check" }))).toEqual({
      label: "Spam · Plugin: Spam check",
      tone: "danger",
    })
    expect(threadPill(comment({ status: "trash", held_reason: null }))).toEqual({ label: "Trash", tone: "neutral" })
    expect(threadPill(comment({ status: "approved" }))).toBeNull()
  })
})

describe("text", () => {
  it("shows the first 300 characters, expandable", () => {
    const long = "é".repeat(301)
    expect(excerpt(long, false)).toEqual({ text: `${"é".repeat(300)}…`, truncated: true })
    expect(excerpt(long, true).truncated).toBe(false)
    expect(excerpt("short", false)).toEqual({ text: "short", truncated: false })
  })

  it("names a comment for a screen reader", () => {
    expect(commentLabel(comment())).toBe("Maya Lindqvist, pending")
    expect(commentLabel(comment({ removed: true }))).toBe("Removed comment")
  })

  it("dates the trash", () => {
    const lines = trashLines({ moderated_at: "2026-11-12T10:00:00Z", moderated_by: "Ana Costa", created_at: "2026-11-01T00:00:00Z" }, new Date("2026-11-20T10:00:00Z"))
    expect(lines).toEqual(["Trashed by Ana Costa · Nov 12", "Deleted Dec 12"])
  })
})

describe("bulk reports (16.1)", () => {
  const names = new Map([
    [1, "Maya"],
    [2, "Tom"],
    [3, "Ana"],
  ])

  it("reports a whole success", () => {
    const r = bulkReport("approve", [{ id: 1, ok: true }, { id: 2, ok: true }], names)
    expect(r).toEqual({ message: "Approved 2 comments.", partial: false, failures: [] })
  })

  it("reports a bulk action that partly applied", () => {
    const results = [
      { id: 1, ok: true },
      { id: 2, ok: false, status: 404, code: "comment_not_found" },
      { id: 3, ok: true },
    ]
    const r = bulkReport("approve", results, names)
    expect(r.message).toBe("Approved 2 of 3. One comment wasn't: it was deleted by someone else meanwhile.")
    expect(r.partial).toBe(true)
    expect(r.failures).toEqual([{ id: 2, name: "Tom", reason: "it was deleted by someone else meanwhile" }])
  })

  it("keeps what failed and still exists selected", () => {
    expect(
      selectionAfterBulk([
        { id: 1, ok: true },
        { id: 2, ok: false, status: 404 },
        { id: 3, ok: false, status: 409, code: "comment_status_changed" },
      ])
    ).toEqual([3])
  })

  it("asks before deleting for good", () => {
    expect(deleteConfirm(3).title).toBe("Delete 3 comments for good?")
    expect(deleteConfirm(1).button).toBe("Delete comment")
  })
})

describe("export and erase (#529, 13.1)", () => {
  const counts = { approved: 10, pending: 2, spam: 1, trash: 1 }
  it("asks before erasing, with the name and the count", () => {
    const ask = eraseConfirm({ name: "Ana", ...counts })
    expect(ask.title).toBe("Delete Ana’s 14 comments and everything stored about this address?")
    expect(ask.body).toContain("“This comment was removed”")
    expect(ask.body).toContain("can't be undone")
    expect(ask.button).toBe("Erase")
    expect(eraseConfirm({ name: "Ana", ...counts, unconfirmed: 1 }).title, "unconfirmed ones are erased too").toBe("Delete Ana’s 15 comments and everything stored about this address?")
    expect(eraseConfirm({ name: "Jonas", approved: 1, pending: 0, spam: 0, trash: 0 }).title).toBe("Delete Jonas’ 1 comment and everything stored about this address?")
    expect(eraseConfirm({ name: " ", approved: 0, pending: 0, spam: 0, trash: 0 }).title).toBe("Delete everything stored about this commenter?")
  })
  it("says what the erasure did, and names the file", () => {
    expect(erasedMessage({ comment_count: 14, tombstoned: 0 })).toBe("Erased 14 comments.")
    expect(erasedMessage({ comment_count: 14, tombstoned: 2 })).toBe("Erased 14 comments. 2 became “This comment was removed”: replies answer them.")
    expect(erasedMessage({ comment_count: 1, tombstoned: 1 })).toBe("Erased 1 comment. One became “This comment was removed”: replies answer it.")
    expect(erasedMessage({ comment_count: 0, tombstoned: 0 })).toBe("Erased the commenter.")
    expect(exportFileName(12)).toBe("commenter-12.json")
  })
})

describe("replies (3.4, 4.4)", () => {
  it("approves a pending comment first", () => {
    expect(replyLabel(comment(), "Luan")).toBe("Reply to Maya as Luan")
    expect(replyButton(comment())).toBe("Approve and reply")
    expect(replyButton(comment({ status: "approved" }))).toBe("Reply")
    expect(replyHint(comment())).toMatch(/^Maya's comment is pending, so replying approves it first\./)
  })

  it("replies only under a pending or approved comment", () => {
    expect(canReplyTo(comment())).toBe(true)
    expect(canReplyTo(comment({ status: "approved" }))).toBe(true)
    expect(canReplyTo(comment({ status: "spam" }))).toBe(false)
    expect(canReplyTo(comment({ status: "approved", removed: true }))).toBe(false)
  })
})

describe("summaries", () => {
  it("describes the commenter and the post's discussion", () => {
    expect(commenterLine({ email: "maya@example.com", verified_at: "2026-11-16T12:00:00Z" })).toBe("maya@example.com · verified Nov 16")
    expect(commenterLine({ email: "maya@example.com", verified_at: null })).toBe("maya@example.com")
    expect(networkLine(3)).toBe("3 other commenters from this network")
    expect(networkLine(0)).toBeNull()
    expect(discussionLine({ state: "open", closes_at: "2026-12-03T12:00:00Z" })).toBe("Comments open · closes Dec 3")
    expect(discussionLine({ state: "closed", closes_at: null })).toBe("Comments closed")
    expect(discussionLine(null)).toBeNull()
  })

  it("reads Home's Needs attention item", () => {
    const now = new Date("2026-11-20T12:00:00Z")
    expect(pendingAttention({ count: 4, post_count: 3, oldest_at: "2026-11-20T10:00:00Z" }, now)).toEqual({
      title: "4 comments await moderation",
      detail: "On 3 posts · the oldest is 2 hours old",
    })
    expect(pendingAttention({ count: 1, post_count: 1, oldest_at: "2026-11-18T12:00:00Z" }, now)).toEqual({
      title: "1 comment awaits moderation",
      detail: "On 1 post · the oldest is 2 days old",
    })
    expect(pendingAttention({ count: 0, post_count: 0, oldest_at: null }, now)).toBeNull()
    expect(pendingAttention(null, now)).toBeNull()
  })

  it("labels the sidebar's entry with its count", () => {
    expect(discussionNavLabel(4)).toBe("Discussion, 4 comments waiting")
    expect(discussionNavLabel(1)).toBe("Discussion, 1 comment waiting")
    expect(discussionNavLabel(0)).toBe("Discussion")
  })

  it("says what an empty tab means", () => {
    expect(emptyQueue("pending", false).title).toBe("Nothing waits for review")
    expect(emptyQueue("trash", true).title).toBe("No comments match")
  })
})
