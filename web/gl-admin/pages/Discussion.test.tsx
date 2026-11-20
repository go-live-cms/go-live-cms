import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import axe from "axe-core"
import type { ModerationComment } from "@gl-admin/lib/api/discussion"

// Discussion's queue (#526): rows as the board draws them, each action calling its route,
// bulk actions with their report, Approve and Spam at 375, the drawer's "Approve and reply"
// keeping a refused reply's text, and the keyboard and screen reader paths (labelled
// checkboxes, the bulk region, axe).

const api = vi.hoisted(() => ({
  getDiscussionComments: vi.fn(),
  getDiscussionThread: vi.fn(),
  moderateComment: vi.fn(),
  bulkModerateComments: vi.fn(),
  deleteCommentPermanently: vi.fn(),
  postMemberComment: vi.fn(),
  editMemberComment: vi.fn(),
  findCommenter: vi.fn(),
  announceDiscussionChanged: vi.fn(),
}))
vi.mock("@gl-admin/lib/api/discussion", () => api)
vi.mock("@gl-admin/lib/auth", () => ({
  authManager: {
    getState: () => ({ accessToken: "token", user: { id: 9, username: "luan", full_name: "Luan", role: "editor" } }),
    subscribe: () => () => {},
  },
}))
const media = vi.hoisted(() => ({ phone: false }))
vi.mock("@gl-admin/lib/hooks/useMediaQuery", () => ({ useMediaQuery: () => media.phone }))
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock("@gl-admin/components/ui/Toast", () => ({ toast: toasts }))

import Discussion from "./Discussion"
import { ApiError } from "@gl-admin/lib/api/errors"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
    commenter: { id: 7, email: "maya.lindqvist@example.com", new: true, blocked: false },
    body: "We tried this with three editors on one launch post and it held up.",
    replying_to: "",
    notify_replies: false,
    edited: false,
    removed: false,
    created_at: new Date(Date.now() - 12 * 60_000).toISOString(),
    approved_at: null,
    moderated_at: null,
    moderated_by: "",
    post: { id: 3, title: "Shipping real-time collaboration", post_type: "post", status: "published", url: "/post/shipping" },
    ...overrides,
  }
}

const MAYA = comment()
const TOM = comment({
  id: 2,
  name: "Tom Okafor",
  held_reason: "links",
  body: "These helped: https://a.example/x https://b.example/y https://c.example/z",
  commenter: { id: 8, email: "tom@okafor.example", new: false, blocked: false },
  post: { id: 4, title: "Plugin API preview", post_type: "post", status: "draft", url: "/post/plugins" },
})

function page(comments: ModerationComment[], enabled = true) {
  return {
    comments,
    counts: { pending: comments.length, approved: 128, spam: 23, trash: 6 },
    comments_enabled: enabled,
    pagination: { page: 1, per_page: 25, total: comments.length, total_pages: 1 },
  }
}

let container: HTMLDivElement
let root: Root

const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
  })

async function render(path = "/discussion") {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/discussion" element={<Discussion />} />
        </Routes>
      </MemoryRouter>
    )
  )
  await settle()
}

const buttons = (label: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).filter((b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label)

async function click(el: HTMLElement) {
  await act(async () => el.click())
  await settle()
}

async function violations(context: Element) {
  const result = await axe.run(context, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
    rules: { "color-contrast": { enabled: false }, region: { enabled: false }, "landmark-one-main": { enabled: false }, "page-has-heading-one": { enabled: false } },
  })
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  media.phone = false
  Object.values(api).forEach((fn) => fn.mockReset())
  Object.values(toasts).forEach((fn) => fn.mockReset())
  api.getDiscussionComments.mockResolvedValue(page([MAYA, TOM]))
  api.moderateComment.mockImplementation(async (id: number) => ({ ...MAYA, id, status: "approved" }))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("the queue (4.4)", () => {
  it("opens on Pending, with the tab counts, each row's reason and the address", async () => {
    await render()
    expect(api.getDiscussionComments).toHaveBeenCalledWith("pending", { post_id: null, commenter_id: null, q: "" }, 1, 25)
    expect(container.querySelector("h1")?.textContent).toBe("Discussion")
    const tabs = Array.from(container.querySelectorAll("[role='tab']")).map((t) => t.textContent)
    expect(tabs).toEqual(["Pending2", "Approved128", "Spam23", "Trash6"])
    const text = container.textContent!
    expect(text).toContain("maya.lindqvist@example.com")
    expect(text).toContain("New commenter")
    expect(text).toContain("First comment")
    expect(text).toContain("3 links · over the limit")
    expect(text).toContain("Post not published")
    expect(document.title).toMatch(/Discussion$/)
  })

  it("approves, marks spam and trashes from a row", async () => {
    await render()
    await click(buttons("Approve Maya Lindqvist's comment")[0])
    expect(api.moderateComment).toHaveBeenCalledWith(1, "approve")
    expect(toasts.success).toHaveBeenCalledWith("Approved. It's on the post now.")
    expect(api.announceDiscussionChanged).toHaveBeenCalled()
    await click(buttons("Spam Tom Okafor's comment")[0])
    expect(api.moderateComment).toHaveBeenCalledWith(2, "spam")
  })

  it("says so when a comment moved meanwhile", async () => {
    api.moderateComment.mockRejectedValue(new ApiError("the comment isn't where this action applies any more", 409, null, "comment_status_changed"))
    await render()
    await click(buttons("Trash Maya Lindqvist's comment")[0])
    expect(toasts.error).toHaveBeenCalledWith("the comment isn't where this action applies any more")
  })

  it("selects rows with labelled checkboxes and runs a bulk action that partly applies", async () => {
    api.bulkModerateComments.mockResolvedValue({
      action: "approve",
      results: [
        { id: 1, ok: true, comment_status: "approved" },
        { id: 2, ok: false, status: 404, code: "comment_not_found", error: "comment not found" },
      ],
      succeeded: 1,
      failed: 1,
    })
    await render()
    const all = container.querySelector<HTMLInputElement>("input[aria-label='Select all on this page']")!
    await click(all)
    const region = container.querySelector("[role='region'][aria-label='Bulk actions']")!
    expect(region.querySelector("[aria-live='polite']")?.textContent).toBe("2 selected")
    expect(Array.from(region.querySelectorAll("button")).map((b) => b.textContent?.trim() || b.getAttribute("aria-label"))).toEqual([
      "Approve",
      "Spam",
      "Trash",
      "Clear selection",
    ])
    await click(buttons("Approve", region)[0])
    expect(api.bulkModerateComments).toHaveBeenCalledWith("approve", [1, 2])
    expect(container.textContent).toContain("Approved 1 of 2. One comment wasn't: it was deleted by someone else meanwhile.")
    expect(container.querySelector("input[aria-label='Select comment by Tom Okafor']")).not.toBeNull()
  })

  it("asks before deleting for good", async () => {
    api.getDiscussionComments.mockResolvedValue(page([comment({ status: "spam", held_reason: "spam_word", held_detail: "replica" })]))
    await render("/discussion?status=spam")
    expect(container.textContent).toContain("Spam word: replica")
    await click(buttons("Delete permanently Maya Lindqvist's comment")[0])
    const dialog = document.querySelector("[role='alertdialog']")!
    expect(dialog.textContent).toContain("Delete this comment for good?")
    api.deleteCommentPermanently.mockResolvedValue(undefined)
    await click(buttons("Delete comment", dialog)[0])
    expect(api.deleteCommentPermanently).toHaveBeenCalledWith(1)
  })

  it("keeps Approve and Spam as buttons at 375, Trash behind More", async () => {
    media.phone = true
    await render()
    const phone = container.querySelector(".gl-dq-acts--phone")!
    expect(Array.from(phone.querySelectorAll(".gl-button")).map((b) => b.textContent?.trim())).toEqual(["Approve", "Spam"])
    expect(buttons("More actions for Maya Lindqvist's comment", phone)).toHaveLength(1)
    await click(buttons("Approve Maya Lindqvist's comment", phone)[0])
    expect(api.moderateComment).toHaveBeenCalledWith(1, "approve")
    await click(buttons("Spam Maya Lindqvist's comment", phone)[0])
    expect(api.moderateComment).toHaveBeenCalledWith(1, "spam")
  })

  it("says comments are off, with the link for admins only", async () => {
    api.getDiscussionComments.mockResolvedValue({ ...page([]), counts: { pending: 0, approved: 0, spam: 0, trash: 0 }, comments_enabled: false })
    await render()
    expect(container.textContent).toContain("Comments are off for this site")
    expect(container.textContent).toContain("An admin can turn them on in Settings › Discussion.")
  })

  it("says nothing waits when Pending is empty, and the queue didn't load on an error", async () => {
    api.getDiscussionComments.mockResolvedValue({ ...page([]), counts: { pending: 0, approved: 1, spam: 0, trash: 0 } })
    await render()
    expect(container.textContent).toContain("Nothing waits for review")
    act(() => root.unmount())
    root = createRoot(container)
    api.getDiscussionComments.mockRejectedValue(new Error("boom"))
    await render()
    expect(container.textContent).toContain("Comments didn't load")
  })

  it("has no axe violations", async () => {
    await render()
    expect(await violations(container)).toEqual([])
  })
})

describe("the drawer (4.4, 3.4)", () => {
  const thread = {
    comment: MAYA,
    thread: [
      comment({ id: 10, name: "Kenji Mori", status: "approved", held_reason: null, commenter: { id: 5, email: "k@mori.example", new: false, blocked: false } }),
      { ...MAYA, root_id: 10, parent_id: 10, replying_to: "Kenji Mori" },
      comment({ id: 12, root_id: 10, parent_id: 10, name: "Luan", badge: "author", commenter: null, author_user_id: 9, status: "approved", held_reason: null }),
    ],
    commenter: {
      id: 7,
      email: "maya.lindqvist@example.com",
      name: "Maya Lindqvist",
      names_used: ["Maya Lindqvist"],
      verified_at: "2026-11-16T12:00:00Z",
      blocked_at: null,
      blocked_by: "",
      last_spam_at: null,
      created_at: "2026-11-16T12:00:00Z",
      approved: 0,
      pending: 1,
      spam: 0,
      trash: 0,
      notify_count: 0,
      network_neighbours: 3,
    },
    discussion: { state: "open", closes_at: null },
  }

  it("shows the thread, the badge and the commenter, and approves before replying", async () => {
    api.getDiscussionThread.mockResolvedValue(thread)
    api.postMemberComment.mockResolvedValue({ comment: { ...MAYA, id: 20 }, parent_approved: true })
    await render("/discussion?comment=1")
    const drawer = document.querySelector("[role='dialog']")!
    expect(drawer.querySelector("[aria-label='Thread']")).not.toBeNull()
    expect(drawer.textContent).toContain("Author")
    expect(drawer.textContent).toContain("Pending · First comment")
    expect(drawer.textContent).toContain("3 other commenters from this network")
    expect(drawer.querySelector("article[aria-label='Maya Lindqvist, pending']")).not.toBeNull()
    const box = drawer.querySelector<HTMLTextAreaElement>("textarea")!
    expect(drawer.querySelector(`label[for='${box.id}']`)?.textContent).toContain("Reply to Maya as Luan")
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Only while people are in the post.")
      box.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const send = buttons("Approve and reply", drawer)[0]
    await click(send)
    expect(api.postMemberComment).toHaveBeenCalledWith(3, "Only while people are in the post.", 1)
    expect(toasts.success.mock.calls[0][0]).toBe("Reply posted. Maya's comment is approved.")
  })

  it("keeps the text of a reply that wasn't posted", async () => {
    api.getDiscussionThread.mockResolvedValue(thread)
    api.postMemberComment.mockRejectedValue(new ApiError("gone", 404, null, "parent_not_found"))
    await render("/discussion?comment=1")
    const drawer = document.querySelector("[role='dialog']")!
    const box = drawer.querySelector<HTMLTextAreaElement>("textarea")!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Keep me")
      box.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await click(buttons("Approve and reply", drawer)[0])
    expect(drawer.querySelector("[role='alert']")?.textContent).toContain("Your reply wasn't posted")
    expect(drawer.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Keep me")
  })

  it("has no reply box at 375, and the actions instead", async () => {
    media.phone = true
    api.getDiscussionThread.mockResolvedValue(thread)
    await render("/discussion?comment=1")
    const drawer = document.querySelector("[role='dialog']")!
    expect(drawer.querySelector("textarea")).toBeNull()
    expect(drawer.textContent).toContain("Replying needs a larger screen.")
    expect(buttons("Approve Maya Lindqvist's comment", drawer)).toHaveLength(1)
  })
})

describe("after a change (review fixes)", () => {
  it("drops a comment a row action moved from the selection", async () => {
    await render()
    await click(container.querySelector<HTMLInputElement>("input[aria-label='Select comment by Maya Lindqvist']")!)
    await click(container.querySelector<HTMLInputElement>("input[aria-label='Select comment by Tom Okafor']")!)
    expect(container.querySelector("[role='region'][aria-label='Bulk actions'] [aria-live]")?.textContent).toBe("2 selected")
    api.getDiscussionComments.mockResolvedValue(page([TOM]))
    await click(buttons("Approve Maya Lindqvist's comment")[0])
    expect(container.querySelector("[role='region'][aria-label='Bulk actions'] [aria-live]")?.textContent).toBe("1 selected")
  })

  it("goes back to the last page when its page emptied", async () => {
    api.getDiscussionComments.mockImplementation(async (_s: string, _f: unknown, p: number) =>
      p === 3 ? { ...page([]), pagination: { page: 3, per_page: 25, total: 30, total_pages: 2 } } : { ...page([MAYA]), pagination: { page: p, per_page: 25, total: 30, total_pages: 2 } }
    )
    await render("/discussion?page=3")
    expect(api.getDiscussionComments).toHaveBeenLastCalledWith("pending", expect.anything(), 2, 25)
    expect(container.textContent).not.toContain("Nothing waits for review")
    expect(container.textContent).toContain("Maya Lindqvist")
  })

  it("doesn't say comments are off when the settings couldn't be read", async () => {
    api.getDiscussionComments.mockResolvedValue({ ...page([]), counts: { pending: 0, approved: 0, spam: 0, trash: 0 }, comments_enabled: null })
    await render()
    expect(container.textContent).not.toContain("Comments are off for this site")
    expect(container.textContent).toContain("Nothing waits for review")
  })
})
