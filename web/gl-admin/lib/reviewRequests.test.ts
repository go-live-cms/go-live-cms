import { describe, expect, it } from "vitest"
import type { ReviewRequest } from "@gl-admin/lib/api/reviewRequests"
import { filterEmptyMessage, readListFilters, filterQuery, hasFilters } from "@gl-admin/lib/contentList"
import {
  ANY_REVIEWER,
  reviewErrorMessage,
  reviewIndicator,
  reviewNotice,
  reviewerOptions,
} from "@gl-admin/lib/reviewRequests"

// Review requests (#323): what the editor's notice says and offers to whom, the list's
// indicator, and the API's codes.

const kenji = { id: 4, username: "kenji", full_name: "Kenji Tanaka", avatar: null }
const ana = { id: 2, username: "ana", full_name: "Ana Costa", avatar: null }
const priya = { id: 9, username: "priya", full_name: "", avatar: null }

const request = (extra: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: 1,
  post_id: 12,
  status: "open",
  message: "",
  resolution_note: "",
  created_at: "2026-10-27T10:00:00Z",
  resolved_at: null,
  requested_by: kenji,
  reviewer: null,
  resolved_by: null,
  ...extra,
})

const reviewer = (id: number) => ({ id, canReview: true, canRequest: true })
const contributor = (id: number) => ({ id, canReview: false, canRequest: true })

describe("reviewNotice", () => {
  it("is nothing without a request, or for one dismissed or published", () => {
    expect(reviewNotice(null, reviewer(2))).toBeNull()
    expect(reviewNotice(request({ status: "dismissed" }), reviewer(2))).toBeNull()
    expect(reviewNotice(request({ status: "published" }), reviewer(2))).toBeNull()
  })

  it("offers a reviewer Approve and publish, Request changes and Dismiss", () => {
    const notice = reviewNotice(request({ reviewer: ana, message: "Ready when you are" }), reviewer(2))
    expect(notice).toMatchObject({
      tone: "info",
      title: "Kenji Tanaka asked you for a review",
      message: "Ready when you are",
      quoted: true,
      actions: ["publish", "request_changes", "dismiss"],
    })
    // Another editor sees whom it names, and can still act.
    expect(reviewNotice(request({ reviewer: ana }), reviewer(5))).toMatchObject({
      title: "Kenji Tanaka asked for a review",
      message: "They asked Ana Costa.",
      quoted: false,
      actions: ["publish", "request_changes", "dismiss"],
    })
    expect(reviewNotice(request(), reviewer(5))?.message).toBe("Publish it, request changes or dismiss the request.")
  })

  it("lets the requester withdraw it", () => {
    expect(reviewNotice(request({ reviewer: ana }), contributor(4))).toMatchObject({
      title: "Review requested from Ana Costa",
      actions: ["withdraw"],
    })
    expect(reviewNotice(request(), contributor(4))?.title).toBe("Review requested from the editors")
    // An editor who asked is a requester first.
    expect(reviewNotice(request({ reviewer: ana }), reviewer(4))?.actions).toEqual(["withdraw"])
  })

  it("tells the owner someone else asked, with nothing to do", () => {
    const notice = reviewNotice(request({ requested_by: ana, reviewer: priya }), contributor(4))
    expect(notice).toMatchObject({ title: "Review requested", message: "Ana Costa asked priya to review it.", actions: [] })
  })

  it("shows the reviewer's note after changes are requested, and lets an author ask again", () => {
    const changes = request({ status: "changes_requested", resolution_note: "Tighten the intro.", resolved_by: ana, resolved_at: "2026-10-28T09:00:00Z" })
    expect(reviewNotice(changes, contributor(4))).toMatchObject({
      tone: "warning",
      title: "Ana Costa requested changes",
      message: "Tighten the intro.",
      quoted: true,
      actions: ["request_again"],
    })
    expect(reviewNotice(changes, reviewer(2))?.title).toBe("You requested changes")
    expect(reviewNotice(changes, { id: 8, canReview: false, canRequest: false })?.actions).toEqual([])
    // A reviewer removed since.
    expect(reviewNotice({ ...changes, resolved_by: null }, contributor(4))?.title).toBe("A reviewer requested changes")
  })
})

describe("reviewIndicator", () => {
  it("labels a row with an open request and says who asked whom", () => {
    expect(reviewIndicator(null, 1)).toBeNull()
    expect(reviewIndicator({ id: 1, created_at: "", requested_by: kenji, reviewer: ana }, 1)).toEqual({
      label: "Review requested",
      detail: "Kenji Tanaka asked Ana Costa for a review",
    })
    expect(reviewIndicator({ id: 1, created_at: "", requested_by: kenji, reviewer: ana }, 2)?.detail).toBe("Kenji Tanaka asked you for a review")
    expect(reviewIndicator({ id: 1, created_at: "", requested_by: kenji, reviewer: null }, 4)?.detail).toBe("You asked the editors for a review")
    expect(reviewIndicator({ id: 1, created_at: "", requested_by: null, reviewer: null }, 4)?.detail).toBe("Someone asked the editors for a review")
  })
})

describe("review errors and reviewer choices", () => {
  it("reads the API's codes", () => {
    expect(reviewErrorMessage("review_already_requested", "x")).toBe("A review was already requested for this post.")
    expect(reviewErrorMessage("review_not_open", "x")).toBe("This review request was already resolved.")
    expect(reviewErrorMessage("invalid_reviewer", "x")).toBe("Pick an editor or admin other than yourself.")
    expect(reviewErrorMessage("post_trashed", "x")).toBe("The post is in the trash. Restore it first.")
    expect(reviewErrorMessage(null, "Couldn't do it")).toBe("Couldn't do it")
  })

  it("offers any reviewer first, never yourself", () => {
    expect(reviewerOptions([kenji, ana, priya], 2)).toEqual([
      { value: ANY_REVIEWER, label: "Any editor or admin" },
      { value: "4", label: "Kenji Tanaka" },
      { value: "9", label: "priya" },
    ])
  })
})

describe("the posts list's Review requested filter", () => {
  it("reads ?review=pending and sends it as review", () => {
    const filters = readListFilters(new URLSearchParams("review=pending&author=3"))
    expect(filters.review).toBe("pending")
    expect(hasFilters(filters)).toBe(true)
    expect(filterQuery(filters)).toEqual({ author_id: "3", terms: "", review: "pending" })
    expect(readListFilters(new URLSearchParams("review=yes")).review).toBe("")
    expect(hasFilters(readListFilters(new URLSearchParams("")))).toBe(false)
  })
})

describe("the filtered list's empty state", () => {
  it("says what the filters ask for", () => {
    const f = (q: string) => filterEmptyMessage(readListFilters(new URLSearchParams(q)), "Drafts")
    expect(f("review=pending")).toBe("Nothing in Drafts is waiting for a review.")
    expect(f("author=3")).toBe("Nothing in Drafts has that author.")
    expect(f("author=3&category=4&tag=5")).toBe("Nothing in Drafts has that author, category and tag together.")
    expect(f("tag=5&review=pending")).toBe("Nothing in Drafts has that tag and a review request.")
  })
})