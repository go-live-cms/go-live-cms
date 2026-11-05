import { useEffect, useMemo, useRef, useState } from "react"
import Combobox from "@gl-admin/components/ui/Combobox"
import Notice from "@gl-admin/components/ui/Notice"
import type { SelectOption } from "@gl-admin/components/ui/Select"
import { getUsers } from "@gl-admin/lib/api/users"
import type { User } from "@gl-admin/lib/api/types"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { memberOptions } from "@gl-admin/lib/members"

// The API's page size cap. The picker loads every member, a page at a time.
const PAGE_SIZE = 100

export async function allMembers(): Promise<User[]> {
    const members: User[] = []
    for (;;) {
        const page = await getUsers({ limit: PAGE_SIZE, offset: members.length, sort: "username_asc" })
        members.push(...page.data)
        if (page.data.length < PAGE_SIZE || members.length >= (page.meta.total ?? 0)) return members
    }
}

// Matches the name, the email or the role, as the Users list's search does.
const matchesMember = (option: SelectOption, query: string) => {
    const q = query.trim().toLowerCase()
    return option.label.toLowerCase().includes(q) || (option.description ?? "").toLowerCase().includes(q)
}

interface MemberPickerProps {
    label: string
    // The picked member's id, or null.
    value: number | null
    onChange: (member: User | null) => void
    me: Pick<User, "id"> | null | undefined
    // Never offered (the member being removed, the post's current owner).
    exclude?: number[]
    // Only these may be picked (a post's owner needs a content role).
    eligible?: (member: User) => boolean
    disabled?: boolean
    emptyMessage?: string
    // Called once the members are loaded (e.g. to pick a default).
    onLoaded?: (members: User[]) => void
}

// Picks a member of the workspace (GET /users, admins): who receives a removed
// member's posts (#333) and who a post is transferred to (#353). You first, then by
// name, each with their email and role.
export default function MemberPicker({
    label,
    value,
    onChange,
    me,
    exclude,
    eligible,
    disabled = false,
    emptyMessage = "No other member matches",
    onLoaded,
}: MemberPickerProps) {
    const [members, setMembers] = useState<User[] | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const loaded = useRef(onLoaded)
    loaded.current = onLoaded

    // Loaded once per mount: the dialogs mount it each time they open.
    useEffect(() => {
        let live = true
        allMembers()
            .then((list) => {
                if (!live) return
                setMembers(list)
                loaded.current?.(list)
            })
            .catch((err) => live && setLoadError(errorMessage(err, "Couldn't load the members.")))
        return () => {
            live = false
        }
    }, [])

    // Keyed by ids, not objects: callers pass fresh arrays, and authManager hands out a
    // new user object on every refresh.
    const excludeKey = (exclude ?? []).join(",")
    const meId = me?.id ?? null
    const options = useMemo(
        () =>
            members
                ? memberOptions(members, {
                      exclude: excludeKey ? excludeKey.split(",").map(Number) : [],
                      me: meId === null ? null : { id: meId },
                      eligible,
                  })
                : [],
        [members, excludeKey, meId, eligible],
    )

    if (loadError) {
        return (
            <Notice tone="danger" live="alert">
                {loadError}
            </Notice>
        )
    }
    return (
        <Combobox
            label={label}
            options={options}
            value={value === null ? null : String(value)}
            onChange={(picked) => onChange(members?.find((m) => String(m.id) === picked) ?? null)}
            filter={matchesMember}
            placeholder={members ? "Search members" : "Loading members…"}
            disabled={!members || disabled}
            emptyMessage={emptyMessage}
        />
    )
}
