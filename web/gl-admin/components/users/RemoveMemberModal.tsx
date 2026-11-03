import { useEffect, useMemo, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Combobox from "@gl-admin/components/ui/Combobox"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import type { SelectOption } from "@gl-admin/components/ui/Select"
import { deleteUser, getUsers } from "@gl-admin/lib/api/users"
import type { User } from "@gl-admin/lib/api/types"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { memberName, reassignSummary, recipientOptions, removeMemberError } from "@gl-admin/lib/members"
import "@gl-admin/assets/styles/components/users/invitations.scss"

interface RemoveMemberModalProps {
    member: User | null
    me: Pick<User, "id"> | null | undefined
    onClose: () => void
    onRemoved: (member: User, recipient: User, postsReassigned: number) => void
}

// The API's page size cap. The picker loads every member, a page at a time.
const PAGE_SIZE = 100

async function allMembers(): Promise<User[]> {
    const members: User[] = []
    for (;;) {
        const page = await getUsers({ limit: PAGE_SIZE, offset: members.length, sort: "username_asc" })
        members.push(...page.data)
        if (page.data.length < PAGE_SIZE || members.length >= (page.meta.total ?? 0)) return members
    }
}

// Matches the name, the email or the role, as the list's search does.
const matchesRecipient = (option: SelectOption, query: string) => {
    const q = query.trim().toLowerCase()
    return option.label.toLowerCase().includes(q) || (option.description ?? "").toLowerCase().includes(q)
}

// Remove member (#333): asks who receives the posts and media they own, then
// DELETE /users/:id with transfer_to_id. The API does it in one transaction, signs them
// out everywhere and closes their open documents.
export default function RemoveMemberModal({ member, me, onClose, onRemoved }: RemoveMemberModalProps) {
    const [members, setMembers] = useState<User[] | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [recipient, setRecipient] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    // Keyed by id, not the object: authManager hands out a new user object on every
    // refresh, which must not reset a recipient already picked.
    const meId = me?.id ?? null

    useEffect(() => {
        if (!member) return
        let live = true
        setMembers(null)
        setLoadError(null)
        setError(null)
        setSaving(false)
        setRecipient(meId !== null && meId !== member.id ? String(meId) : null)
        allMembers()
            .then((list) => live && setMembers(list))
            .catch((err) => live && setLoadError(errorMessage(err, "Couldn't load the members.")))
        return () => {
            live = false
        }
    }, [member, meId])

    const options = useMemo(() => (member && members ? recipientOptions(members, member, me) : []), [members, member, me])

    if (!member) return null
    const name = memberName(member)

    const remove = async () => {
        const to = members?.find((m) => String(m.id) === recipient)
        if (!to) {
            setError("Choose who receives their posts.")
            return
        }
        setError(null)
        setSaving(true)
        try {
            const { posts_reassigned } = await deleteUser(member.id, to.id)
            onRemoved(member, to, posts_reassigned ?? 0)
        } catch (err) {
            setError(removeMemberError(err, member))
            setSaving(false)
        }
    }

    return (
        <Modal
            isOpen
            onClose={() => !saving && onClose()}
            role="alertdialog"
            size="medium"
            closeOnBackdrop={false}
            title={`Remove ${name}?`}
            description="They lose access right away and are signed out everywhere. This can't be undone."
            footer={
                <>
                    <Button variant="secondary" size="lg" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button variant="danger" size="lg" loading={saving} disabled={!members || !recipient} onClick={remove}>
                        Remove member
                    </Button>
                </>
            }
        >
            <div className="gl-invite-form">
                {loadError ? (
                    <Notice tone="danger" live="alert">
                        {loadError}
                    </Notice>
                ) : (
                    <Combobox
                        label={reassignSummary(member)}
                        options={options}
                        value={recipient}
                        onChange={setRecipient}
                        filter={matchesRecipient}
                        placeholder={members ? "Search members" : "Loading members…"}
                        disabled={!members || saving}
                        emptyMessage="No other member matches"
                    />
                )}
                {error && (
                    <Notice tone="danger" live="alert">
                        {error}
                    </Notice>
                )}
            </div>
        </Modal>
    )
}
