import { describe, expect, it } from "vitest"
import { ApiError } from "./api/errors"
import type { PostAccess } from "./api/postAccess"
import { accessErrorMessage, memberName, requestTitle, VIEW_ONLY_MESSAGE, viewOnlyNotice } from "./postAccess"
import { canEditPost, canEditPostDetails, postEditorAccess } from "./roles"

// Edit access requests (#321): what the view-only notice offers, and that a grant is what
// makes someone else's published post editable (mirroring api/auth_posts.go).

const access = (overrides: Partial<PostAccess> = {}): PostAccess => ({
  can_edit: false,
  collaborator: false,
  can_request: false,
  request: null,
  can_review: false,
  pending: null,
  collaborators: null,
  ...overrides,
})

const request = (status: "pending" | "granted" | "declined", extra = {}) => ({
  id: 4,
  post_id: 9,
  status,
  message: "",
  created_at: "2026-11-04T10:00:00Z",
  reviewed_at: status === "pending" ? null : "2026-11-04T11:00:00Z",
  ...extra,
})

describe("viewOnlyNotice", () => {
  it("offers Request access to someone who may ask", () => {
    expect(viewOnlyNotice(access({ can_request: true }))).toEqual({ message: VIEW_ONLY_MESSAGE, action: "request" })
    // A revoked grant leaves its granted request behind: they may ask again.
    expect(viewOnlyNotice(access({ can_request: true, request: request("granted") })).action).toBe("request")
  })

  it("says a request was sent while it waits", () => {
    const notice = viewOnlyNotice(access({ request: request("pending") }))
    expect(notice.action).toBe("sent")
    expect(notice.message).toContain("as soon as the owner or an editor grants it")
  })

  it("says a request was declined, and when they may ask again", () => {
    const notice = viewOnlyNotice(access({ request: request("declined", { request_again_at: "2026-11-05T11:00:00Z" }) }))
    expect(notice.action).toBeNull()
    expect(notice.message).toMatch(/^Your request for edit access was declined\. You can ask again after Nov \d/)
    expect(viewOnlyNotice(access({ request: request("declined") })).message).toBe("Your request for edit access was declined.")
    // Past the cooldown the API says they may ask again.
    expect(viewOnlyNotice(access({ can_request: true, request: request("declined") })).action).toBe("request")
  })

  it("has no action when access isn't loaded or can't be asked for", () => {
    expect(viewOnlyNotice(null)).toEqual({ message: VIEW_ONLY_MESSAGE, action: null })
    expect(viewOnlyNotice(access())).toEqual({ message: VIEW_ONLY_MESSAGE, action: null })
  })
})

describe("names and errors", () => {
  it("names the member", () => {
    expect(memberName({ full_name: "Kenji Tanaka", username: "kenji" })).toBe("Kenji Tanaka")
    expect(memberName({ full_name: "", username: "kenji" })).toBe("kenji")
    expect(memberName(null)).toBe("Someone")
    expect(requestTitle({ ...request("pending"), requester: { id: 5, username: "kenji", full_name: "Kenji Tanaka" } })).toBe(
      "Kenji Tanaka asked for edit access"
    )
  })

  it("words the API's codes", () => {
    const err = (status: number, code: string | null, message = "Server says no.") => new ApiError(message, status, null, code)
    expect(accessErrorMessage(err(409, "request_open"))).toBe("You already asked for edit access to this post.")
    expect(accessErrorMessage(err(409, "recently_declined"))).toMatch(/declined recently/)
    expect(accessErrorMessage(err(409, "already_has_access"))).toBe("You can already edit this post.")
    expect(accessErrorMessage(err(409, "already_answered"))).toBe("Someone already answered this request.")
    expect(accessErrorMessage(err(404, "not_a_collaborator"))).toBe("That member no longer has edit access.")
    expect(accessErrorMessage(err(429, null, "Too many requests. Try again in 20 seconds."))).toBe("Too many requests. Try again in 20 seconds.")
    expect(accessErrorMessage(new Error("offline"))).toBe("offline")
  })
})

describe("grants in the permission rules (canEditWorkingCopy)", () => {
  const contributor = { id: 5, role: "contributor" }
  const theirs = (post_status: string, collaborator = true) => ({ user_id: 9, post_status, collaborator })

  it("a grant lets a contributor edit the content of someone else's published post", () => {
    expect(canEditPost(contributor, theirs("published"))).toBe(true)
    expect(canEditPost(contributor, theirs("published", false))).toBe(false)
    expect(postEditorAccess(contributor, "edit", theirs("published"))).toEqual({ content: true, details: false, publish: false })
  })

  it("only while it's published, never the details, never in the trash", () => {
    for (const status of ["draft", "scheduled", "archived", "trash"]) {
      expect(canEditPost(contributor, theirs(status)), status).toBe(false)
    }
    expect(canEditPostDetails(contributor, theirs("published"))).toBe(false)
    // Not a contributor's role: no grant applies (moderators edit anyway).
    expect(canEditPost({ id: 5, role: "subscriber" }, theirs("published"))).toBe(false)
    // Their own post is ownership's rule.
    expect(canEditPost(contributor, { user_id: 5, post_status: "scheduled", collaborator: true })).toBe(false)
  })
})
