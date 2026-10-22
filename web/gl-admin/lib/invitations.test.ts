import { describe, expect, it } from "vitest"
import { ApiError } from "./api/errors"
import { describeExpiry, describeInvitationError, invitationSentNotice, validateInvitation } from "./invitations"
import type { Invitation } from "./api/invitations"

const invitation: Invitation = {
  id: 1,
  email: "new@example.com",
  role: "editor",
  invited_by: 2,
  expires_at: "2030-01-04T00:00:00Z",
  created_at: "2030-01-01T00:00:00Z",
  status: "pending",
}

describe("validateInvitation", () => {
  it("needs an email and one of the API's roles", () => {
    expect(validateInvitation("new@example.com", "editor")).toBeNull()
    expect(validateInvitation(" new@example.com ", "admin")).toBeNull()
    expect(validateInvitation("new", "editor")).toMatch(/email/)
    expect(validateInvitation("new@example.com", "superuser")).toMatch(/role/)
    expect(validateInvitation("new@example.com", "")).toMatch(/role/)
  })
})

describe("describeInvitationError", () => {
  it("explains the API's conflict and gone cases", () => {
    expect(describeInvitationError(new ApiError("x", 409, null, "email_registered"))).toMatch(/already exists/)
    expect(describeInvitationError(new ApiError("x", 404))).toMatch(/accepted or revoked/)
    expect(describeInvitationError(new ApiError("Nope.", 400))).toBe("Nope.")
  })
})

describe("invitationSentNotice", () => {
  it("warns when the email failed", () => {
    expect(invitationSentNotice({ invitation, email_sent: true })).toEqual({
      type: "success",
      message: "Invitation sent to new@example.com.",
    })
    const failed = invitationSentNotice({ invitation, email_sent: false })
    expect(failed.type).toBe("warning")
    expect(failed.message).toMatch(/resending/)
  })
})

describe("describeExpiry", () => {
  const now = Date.parse("2030-01-01T00:00:00Z")
  it("counts down in days, hours, then minutes", () => {
    expect(describeExpiry(invitation, now)).toBe("Expires in 3 days")
    expect(describeExpiry(invitation, now + 5_000)).toBe("Expires in 3 days")
    expect(describeExpiry({ ...invitation, expires_at: "2030-01-01T05:30:00Z" }, now)).toBe("Expires in 5 hours")
    expect(describeExpiry({ ...invitation, expires_at: "2030-01-01T01:00:00Z" }, now)).toBe("Expires in 1 hour")
    expect(describeExpiry({ ...invitation, expires_at: "2030-01-01T00:10:00Z" }, now)).toBe("Expires in 10 minutes")
  })

  it("says expired", () => {
    expect(describeExpiry({ ...invitation, expires_at: "2029-12-31T00:00:00Z" }, now)).toBe("Expired")
    expect(describeExpiry({ ...invitation, status: "expired" }, now)).toBe("Expired")
  })
})
