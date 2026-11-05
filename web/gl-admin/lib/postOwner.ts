// A post's owner (#353): who may transfer it, who may receive it, and what the
// Transfer dialog says. The owner (user_id) is what permissions read; the byline
// (#319) only credits. Tested in postOwner.test.ts.
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import type { PostAuthor, User } from "@gl-admin/lib/api/types"
import { canCreateContent, isSiteAdmin } from "@gl-admin/lib/roles"

type Named = Pick<PostAuthor, "full_name" | "username">

export function ownerName(owner: Named): string {
  return owner.full_name || owner.username
}

// "Luan (you)" in the Owner field.
export function ownerLabel(owner: Named & { id: number }, me: { id: number } | null | undefined): string {
  return me && owner.id === me.id ? `${ownerName(owner)} (you)` : ownerName(owner)
}

// Admins only (the API's rule: editors can't). Never a post in the trash.
export function canTransferPost(user: { role?: string | null } | null | undefined, post: { post_status?: string | null }): boolean {
  return !!user && isSiteAdmin(user.role) && post.post_status !== "trash"
}

// Who may own a post: an active member, i.e. one with a content role (the API's
// contentRoles: removed members are gone from the list already).
export function canOwnPosts(member: Pick<User, "role">): boolean {
  return canCreateContent(member.role)
}

// The checkbox: the old owner's own words when it's you ("also replace me").
export function replaceInBylineLabel(owner: Named & { id: number }, me: { id: number } | null | undefined): string {
  return me && owner.id === me.id ? "Also replace me in the byline" : `Also replace ${ownerName(owner)} in the byline`
}

// The confirm line under the picker: "Ana Costa will own this post. You keep your
// place in the byline." `ownerCredited`: the old owner is in the byline (otherwise
// there's no place to keep or give, and the dialog offers no replacing).
export function transferConfirmLine(
  next: Named,
  owner: Named & { id: number },
  me: { id: number } | null | undefined,
  replaceInByline: boolean,
  ownerCredited = true,
): string {
  const you = !!me && owner.id === me.id
  const name = ownerName(next)
  const byline = !ownerCredited
    ? "The byline stays as it is."
    : replaceInByline
      ? you
        ? `${name} takes your place in the byline.`
        : `${name} takes ${ownerName(owner)}’s place in the byline.`
      : you
        ? "You keep your place in the byline."
        : "The byline stays as it is."
  return `${name} will own this post. ${byline}`
}

// After the transfer: what the field's notice says.
export function transferredNotice(next: Named, replaced: boolean): string {
  return replaced ? `${ownerName(next)} owns this post now and is in the byline.` : `${ownerName(next)} owns this post now.`
}

export function transferError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "invalid_owner") return "Choose an active member to own this post."
    if (err.code === "already_owner") return "They already own this post."
    if (err.code === "post_trashed") return "This post is in the trash. Restore it first."
  }
  return errorMessage(err, "Couldn't transfer the post.")
}
