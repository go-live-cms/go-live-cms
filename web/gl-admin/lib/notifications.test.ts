import { describe, expect, it } from "vitest"
import {
  COMMENTS_ON_POSTS_OPTIONS,
  COMMENTS_TO_MODERATE_OPTIONS,
  isCommentsOnPosts,
  isCommentsToModerate,
  notificationsSavedMessage,
} from "./notifications"

// Profile's Notifications (#528, design 8.3): the choices are the API's (binding oneof), and
// every choice has its line and its saved message.
describe("notifications", () => {
  it("offers exactly the API's values", () => {
    expect(COMMENTS_ON_POSTS_OPTIONS.map((o) => o.value)).toEqual(["each", "digest", "off"])
    expect(COMMENTS_TO_MODERATE_OPTIONS.map((o) => o.value)).toEqual(["hourly", "off"])
    expect(isCommentsOnPosts("weekly")).toBe(false)
    expect(isCommentsToModerate("each")).toBe(false)
    for (const o of [...COMMENTS_ON_POSTS_OPTIONS, ...COMMENTS_TO_MODERATE_OPTIONS]) expect(o.description).toBeTruthy()
  })

  it("says what each saved choice means", () => {
    expect(notificationsSavedMessage("comments_on_posts", "digest")).toContain("one mail a day")
    expect(notificationsSavedMessage("comments_on_posts", "off")).toContain("won't")
    expect(notificationsSavedMessage("comments_to_moderate", "hourly")).toContain("one mail an hour")
    expect(notificationsSavedMessage("comments_to_moderate", "off")).toContain("won't")
  })
})