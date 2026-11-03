import { describe, expect, it } from "vitest"
import { ApiError } from "@gl-admin/lib/api/errors"
import type { User } from "@gl-admin/lib/api/types"
import {
    canRemoveMember,
    demotesSelf,
    lastActiveLabel,
    reassignSummary,
    recipientOptions,
    removeMemberError,
    removedNotice,
    roleChangeError,
    roleChangedNotice,
} from "./members"

const user = (id: number, full_name: string, role = "editor", over: Partial<User> = {}): User => ({
    id,
    username: full_name.toLowerCase().replace(/\s/g, ""),
    full_name,
    email: `${full_name.split(" ")[0].toLowerCase()}@golive.dev`,
    role,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
})

describe("lastActiveLabel", () => {
    const now = new Date("2026-11-03T15:00:00")

    it("is Never without a record", () => {
        expect(lastActiveLabel(null, now)).toBe("Never")
        expect(lastActiveLabel(undefined, now)).toBe("Never")
        expect(lastActiveLabel("not a date", now)).toBe("Never")
    })

    it("is Now within the API's 5-minute write interval", () => {
        expect(lastActiveLabel("2026-11-03T14:57:00", now)).toBe("Now")
        expect(lastActiveLabel("2026-11-03T14:55:01", now)).toBe("Now")
    })

    it("then reads like the content list's Last edited", () => {
        expect(lastActiveLabel("2026-11-03T14:40:00", now)).toBe("20 minutes ago")
        expect(lastActiveLabel("2026-11-03T09:00:00", now)).toBe("6 hours ago")
        expect(lastActiveLabel("2026-11-02T22:00:00", now)).toBe("Yesterday")
        expect(lastActiveLabel("2026-10-25T10:00:00", now)).toBe("Oct 25")
        expect(lastActiveLabel("2025-10-25T10:00:00", now)).toBe("Oct 25, 2025")
    })
})

describe("removal", () => {
    const me = user(1, "Luan Admin", "admin")
    const ana = user(2, "Ana Costa")
    const marco = user(3, "Marco Ruiz", "contributor")
    const bea = user(4, "Bea Lima")

    it("never offers to remove yourself", () => {
        expect(canRemoveMember(ana, me)).toBe(true)
        expect(canRemoveMember(me, me)).toBe(false)
        expect(canRemoveMember(ana, null)).toBe(false)
    })

    it("offers everyone but the member as the recipient, you first, then by name", () => {
        const options = recipientOptions([marco, ana, me, bea], marco, me)
        expect(options.map((o) => o.label)).toEqual(["Luan Admin (you)", "Ana Costa", "Bea Lima"])
        expect(options[0]).toMatchObject({ value: "1", description: "luan@golive.dev · Administrator" })
    })

    it("says what moves", () => {
        expect(reassignSummary({ posts_owned: 12 })).toBe("Their 12 posts and the media they uploaded will belong to:")
        expect(reassignSummary({ posts_owned: 1 })).toBe("Their 1 post and the media they uploaded will belong to:")
        expect(reassignSummary({ posts_owned: 0 })).toBe("They own no posts. The media they uploaded will belong to:")
        expect(reassignSummary({})).toBe("They own no posts. The media they uploaded will belong to:")
    })

    it("explains the API's refusals", () => {
        const refused = (code: string, status = 409) => new ApiError("Request failed.", status, null, code)
        expect(removeMemberError(refused("last_admin"), me)).toBe("Luan Admin is the only administrator. Make someone else an administrator first.")
        expect(removeMemberError(refused("cannot_remove_self"), me)).toBe("You can't remove your own account. Another administrator can.")
        expect(removeMemberError(refused("invalid_transfer_target", 400), ana)).toBe("Choose another member to receive their posts.")
        expect(removeMemberError(new ApiError("Something went wrong on the server.", 500), ana)).toBe("Something went wrong on the server.")
    })

    it("confirms where the posts went", () => {
        expect(removedNotice(marco, ana, 3)).toBe("Marco Ruiz was removed. 3 posts now belong to Ana Costa.")
        expect(removedNotice(marco, ana, 0)).toBe("Marco Ruiz was removed.")
    })
})

describe("role change", () => {
    const me = user(1, "Luan Admin", "admin")

    it("warns only when you'd give up your own admin access", () => {
        expect(demotesSelf(me, me, "editor")).toBe(true)
        expect(demotesSelf(me, me, "admin")).toBe(false)
        expect(demotesSelf(user(2, "Ana Costa", "admin"), me, "editor")).toBe(false)
    })

    it("explains the last-admin refusal", () => {
        expect(roleChangeError(new ApiError("x", 409, null, "last_admin"), me)).toBe(
            "Luan Admin is the only administrator. Make someone else an administrator first."
        )
        expect(roleChangeError(new ApiError("Couldn't reach the server.", 0), me)).toBe("Couldn't reach the server.")
    })

    it("confirms the new role with the right article", () => {
        expect(roleChangedNotice(user(2, "Ana Costa", "editor"))).toBe("Ana Costa is now an editor.")
        expect(roleChangedNotice(user(2, "Ana Costa", "admin"))).toBe("Ana Costa is now an administrator.")
        expect(roleChangedNotice(user(2, "Ana Costa", "contributor"))).toBe("Ana Costa is now a contributor.")
    })
})
