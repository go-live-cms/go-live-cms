import { ApiError } from "@gl-admin/lib/api/errors"
import { ACCESS_CODES, type AccessRequest, type PostAccess } from "@gl-admin/lib/api/postAccess"
import type { PostAuthor } from "@gl-admin/lib/api/types"

// Edit access requests (#321): what the editor's view-only notice and the reviewers'
// notice say, from GET /posts/:id/access. The API decides who may ask and who may answer
// (api/auth_posts.go); this only words it.

// The API's limit on the optional message (characters), api/posts_access.go.
export const ACCESS_REQUEST_MESSAGE_MAX = 500

export const VIEW_ONLY_MESSAGE = "You can edit only posts you wrote. You still see others' changes as they type."

export type ViewOnlyNotice = {
  message: string
  // "request": the Request access button; "sent": a disabled "Request sent"; null: none.
  action: "request" | "sent" | null
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

// The view-only notice for someone who can't edit the post: whether they may ask for
// edit access, or what happened to the request they made. `access` null = not loaded
// (or failed): the plain notice, no action.
export function viewOnlyNotice(access: PostAccess | null): ViewOnlyNotice {
  if (!access) return { message: VIEW_ONLY_MESSAGE, action: null }
  const request = access.request
  if (request?.status === "pending") {
    return {
      message: "You asked for edit access. You can edit here as soon as the owner or an editor grants it.",
      action: "sent",
    }
  }
  if (access.can_request) {
    // A revoked grant leaves its granted request behind: ask again.
    return { message: VIEW_ONLY_MESSAGE, action: "request" }
  }
  if (request?.status === "declined") {
    const again = request.request_again_at ? ` You can ask again after ${shortDate(request.request_again_at)}.` : ""
    return { message: `Your request for edit access was declined.${again}`, action: null }
  }
  return { message: VIEW_ONLY_MESSAGE, action: null }
}

// The name a request or grant shows: full name, else username.
export function memberName(person: Pick<PostAuthor, "full_name" | "username"> | null | undefined): string {
  return (person?.full_name || person?.username || "Someone").trim()
}

// "Kenji Tanaka asked for edit access".
export function requestTitle(request: AccessRequest): string {
  return `${memberName(request.requester)} asked for edit access`
}

// Errors of the request/answer/revoke calls, in words.
export function accessErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case ACCESS_CODES.requestOpen:
        return "You already asked for edit access to this post."
      case ACCESS_CODES.recentlyDeclined:
        return "Your last request for this post was declined recently. Try again later."
      case ACCESS_CODES.alreadyHasAccess:
        return "You can already edit this post."
      case ACCESS_CODES.alreadyAnswered:
        return "Someone already answered this request."
      case ACCESS_CODES.notCollaborator:
        return "That member no longer has edit access."
    }
    // The API's own wording otherwise (429: "Too many requests…", 403, 404).
    return error.message
  }
  return error instanceof Error ? error.message : "Something went wrong."
}
