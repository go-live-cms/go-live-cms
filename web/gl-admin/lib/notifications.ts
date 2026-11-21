import type { RadioOption } from "@gl-admin/components/ui/RadioGroup"
import type { CommentsOnPosts, CommentsToModerate } from "@gl-admin/lib/api/users"

// Profile's Notifications (#528, docs/design/reader-comments.md 8.3, the canvas's Profile board):
// two radio groups, each mail described in a line. Authors get the daily digest by default
// (section 18, decision 8); moderators an hourly mail at most.

export const COMMENTS_ON_POSTS_OPTIONS: (RadioOption & { value: CommentsOnPosts })[] = [
  { value: "each", label: "Each one", description: "A few minutes after it's approved; several at once come as one mail." },
  { value: "digest", label: "Daily digest", description: "One mail a day, in the morning, with the day's comments." },
  { value: "off", label: "Off", description: "No mail. Discussion still lists them." },
]

export const COMMENTS_TO_MODERATE_OPTIONS: (RadioOption & { value: CommentsToModerate })[] = [
  { value: "hourly", label: "Each hour at most", description: "When new comments wait for review: how many, and on which posts." },
  { value: "off", label: "Off", description: "No mail. Discussion's count still shows them." },
]

export function isCommentsOnPosts(value: string): value is CommentsOnPosts {
  return COMMENTS_ON_POSTS_OPTIONS.some((o) => o.value === value)
}

export function isCommentsToModerate(value: string): value is CommentsToModerate {
  return COMMENTS_TO_MODERATE_OPTIONS.some((o) => o.value === value)
}

/** The status line after a save. */
export function notificationsSavedMessage(field: "comments_on_posts" | "comments_to_moderate", value: string): string {
  if (field === "comments_on_posts") {
    if (value === "each") return "Saved. You'll get a mail a few minutes after a comment on your posts is approved."
    if (value === "digest") return "Saved. You'll get one mail a day about comments on your posts."
    return "Saved. You won't get mail about comments on your posts."
  }
  return value === "hourly" ? "Saved. You'll get at most one mail an hour about comments to moderate." : "Saved. You won't get mail about comments to moderate."
}