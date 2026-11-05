import { personName } from "@gl-admin/lib/activityFeed"
import type { ReviewPerson, ReviewRequest, ReviewRequestSummary } from "@gl-admin/lib/api/reviewRequests"

// Review requests (#323): how the editor's notice, the posts list's indicator and
// the API's error codes read. The API is api/review_requests.go; publishing resolves
// a request whichever way the post is published.

export const REVIEW_REQUESTED_LABEL = "Review requested"

// The API's codes (api/review_requests.go).
export const REVIEW_ALREADY_REQUESTED = "review_already_requested"
export const REVIEW_NOT_OPEN = "review_not_open"
export const INVALID_REVIEWER = "invalid_reviewer"

// The API's limits on the two notes.
export const REVIEW_MESSAGE_MAX = 1000
export const REVIEW_NOTE_MAX = 2000

// A member's name as Home's feeds show it (activityFeed's personName).
export const reviewPersonName = personName

// "You", the person's name, or a fallback for a member removed since.
function nameFor(person: ReviewPerson | null | undefined, meId: number | null | undefined, fallback: string): string {
  if (person && meId != null && person.id === meId) return "You"
  return reviewPersonName(person) || fallback
}

export type ReviewAction = "publish" | "request_changes" | "dismiss" | "withdraw" | "request_again"

export type ReviewNotice = {
  tone: "info" | "warning"
  title: string
  // The requester's or reviewer's note (plain text), or a line about what happens next.
  message: string
  // The note is someone's words (shown as a quote), not ours.
  quoted: boolean
  actions: ReviewAction[]
}

export type ReviewViewer = {
  id: number | null | undefined
  // May publish (editors and admins): reviewers.
  canReview: boolean
  // May edit the post, so may ask for a review (canRequestReview).
  canRequest: boolean
}

// reviewNotice is the editor's review banner for the post's current request (an open
// one, or one with changes requested since the last publish), or null for none.
export function reviewNotice(request: ReviewRequest | null, viewer: ReviewViewer): ReviewNotice | null {
  if (!request) return null
  const mine = !!request.requested_by && viewer.id != null && request.requested_by.id === viewer.id

  if (request.status === "changes_requested") {
    const by = nameFor(request.resolved_by, viewer.id, "A reviewer")
    return {
      tone: "warning",
      title: by === "You" ? "You requested changes" : `${by} requested changes`,
      message: request.resolution_note,
      quoted: true,
      actions: viewer.canRequest ? ["request_again"] : [],
    }
  }
  if (request.status !== "open") return null

  const requester = nameFor(request.requested_by, viewer.id, "Someone")
  const assignedToMe = !!request.reviewer && viewer.id != null && request.reviewer.id === viewer.id
  const reviewerName = request.reviewer ? nameFor(request.reviewer, viewer.id, "an editor") : null

  if (mine) {
    const from = reviewerName ? `from ${reviewerName === "You" ? "yourself" : reviewerName}` : "from the editors"
    return {
      tone: "info",
      title: `Review requested ${from}`,
      message: request.message || "They were emailed. Publishing the post, or a request for changes, ends it.",
      quoted: !!request.message,
      actions: ["withdraw"],
    }
  }
  if (viewer.canReview) {
    return {
      tone: "info",
      title: assignedToMe ? `${requester} asked you for a review` : `${requester} asked for a review`,
      message: request.message || (reviewerName && !assignedToMe ? `They asked ${reviewerName}.` : "Publish it, request changes or dismiss the request."),
      quoted: !!request.message,
      actions: ["publish", "request_changes", "dismiss"],
    }
  }
  // The post's owner, when someone else (an editor) asked.
  return {
    tone: "info",
    title: REVIEW_REQUESTED_LABEL,
    message: `${requester} asked ${reviewerName ?? "the editors"} to review it.`,
    quoted: false,
    actions: [],
  }
}

// The list row's indicator: its label and a line for the tooltip/screen readers.
export function reviewIndicator(summary: ReviewRequestSummary | null | undefined, meId: number | null | undefined): { label: string; detail: string } | null {
  if (!summary) return null
  const requester = nameFor(summary.requested_by, meId, "Someone")
  const reviewer = summary.reviewer ? nameFor(summary.reviewer, meId, "an editor") : null
  const asked = reviewer ? (reviewer === "You" ? "you" : reviewer) : "the editors"
  const verb = requester === "You" ? "You asked" : `${requester} asked`
  return { label: REVIEW_REQUESTED_LABEL, detail: `${verb} ${asked} for a review` }
}

// A rejected review action, as the editor shows it.
export function reviewErrorMessage(code: string | null | undefined, fallback: string): string {
  switch (code) {
    case REVIEW_ALREADY_REQUESTED:
      return "A review was already requested for this post."
    case REVIEW_NOT_OPEN:
      return "This review request was already resolved."
    case INVALID_REVIEWER:
      return "Pick an editor or admin other than yourself."
    case "post_trashed":
      return "The post is in the trash. Restore it first."
    default:
      return fallback
  }
}

// The Request review dialog's reviewer choices: "Any editor or admin" first, then
// every reviewer but you (the API refuses naming yourself).
export const ANY_REVIEWER = ""

export function reviewerOptions(reviewers: ReviewPerson[], meId: number | null | undefined): { value: string; label: string }[] {
  return [
    { value: ANY_REVIEWER, label: "Any editor or admin" },
    ...reviewers.filter((r) => r.id !== meId).map((r) => ({ value: String(r.id), label: reviewPersonName(r) || r.username })),
  ]
}
