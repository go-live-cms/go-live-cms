// The Users screen's rules (#333): the Last active and Posts owned columns, who can be
// removed, who may receive a removed member's posts, and what the role and remove
// dialogs say when the API refuses. Tested in members.test.ts.
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import type { User } from "@gl-admin/lib/api/types"
import { formatLastEdited } from "@gl-admin/lib/contentList"
import { isSiteAdmin, roleLabel } from "@gl-admin/lib/roles"
import { plural } from "@gl-admin/utils/formatting"

// The API writes last_active_at at most once per LAST_ACTIVE_INTERVAL (5 minutes by
// default), so anything newer than that is as good as "now".
export const LAST_ACTIVE_PRECISION_MS = 5 * 60_000

// "Now", "12 minutes ago", "Yesterday", "Oct 24"; "Never" when the API has no record
// (not signed in since #333 shipped, or never).
export function lastActiveLabel(lastActiveAt: string | null | undefined, now: Date = new Date()): string {
    if (!lastActiveAt) return "Never"
    const at = Date.parse(lastActiveAt)
    if (Number.isNaN(at)) return "Never"
    if (now.getTime() - at < LAST_ACTIVE_PRECISION_MS) return "Now"
    return formatLastEdited(lastActiveAt, now)
}

export function memberName(user: Pick<User, "full_name" | "username">): string {
    return user.full_name || user.username
}

// An admin can't remove their own account (the API answers 409): another admin can.
export function canRemoveMember(member: Pick<User, "id">, me: Pick<User, "id"> | null | undefined): boolean {
    return !!me && member.id !== me.id
}

// Who may receive a removed member's posts: anyone else, with the person removing
// them first (the dialog's default), then by name.
export function recipientOptions(members: User[], removing: Pick<User, "id">, me: Pick<User, "id"> | null | undefined) {
    return members
        .filter((m) => m.id !== removing.id)
        .sort((a, b) => {
            if (me && a.id === me.id) return -1
            if (me && b.id === me.id) return 1
            return memberName(a).localeCompare(memberName(b))
        })
        .map((m) => ({
            value: String(m.id),
            label: me && m.id === me.id ? `${memberName(m)} (you)` : memberName(m),
            description: `${m.email} · ${roleLabel(m.role)}`,
        }))
}

// What the remove dialog says will move.
export function reassignSummary(member: Pick<User, "posts_owned">): string {
    const owned = member.posts_owned ?? 0
    return owned > 0
        ? `Their ${plural(owned, "post", "posts")} and the media they uploaded will belong to:`
        : "They own no posts. The media they uploaded will belong to:"
}

// A role change that takes the caller's own admin access away.
export function demotesSelf(member: Pick<User, "id" | "role">, me: Pick<User, "id"> | null | undefined, role: string): boolean {
    return !!me && member.id === me.id && isSiteAdmin(member.role) && !isSiteAdmin(role)
}

export function roleChangeError(err: unknown, member: Pick<User, "full_name" | "username">): string {
    if (err instanceof ApiError && err.code === "last_admin") {
        return `${memberName(member)} is the only administrator. Make someone else an administrator first.`
    }
    return errorMessage(err, "Couldn't change the role.")
}

export function removeMemberError(err: unknown, member: Pick<User, "full_name" | "username">): string {
    if (err instanceof ApiError) {
        if (err.code === "last_admin") {
            return `${memberName(member)} is the only administrator. Make someone else an administrator first.`
        }
        if (err.code === "cannot_remove_self") return "You can't remove your own account. Another administrator can."
        if (err.code === "invalid_transfer_target") return "Choose another member to receive their posts."
    }
    return errorMessage(err, `Couldn't remove ${memberName(member)}.`)
}

// "Ana Costa is now an editor."
export function roleChangedNotice(user: Pick<User, "full_name" | "username" | "role">): string {
    const role = (roleLabel(user.role) ?? user.role).toLowerCase()
    return `${memberName(user)} is now ${/^[aeiou]/.test(role) ? "an" : "a"} ${role}.`
}

export function removedNotice(member: Pick<User, "full_name" | "username">, recipient: Pick<User, "full_name" | "username">, moved: number): string {
    const name = memberName(member)
    return moved > 0
        ? `${name} was removed. ${plural(moved, "post", "posts")} now belong to ${memberName(recipient)}.`
        : `${name} was removed.`
}
