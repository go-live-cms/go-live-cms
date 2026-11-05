import { useEffect, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import MemberPicker from "@gl-admin/components/users/MemberPicker"
import { deleteUser } from "@gl-admin/lib/api/users"
import type { User } from "@gl-admin/lib/api/types"
import { memberName, reassignSummary, removeMemberError } from "@gl-admin/lib/members"
import "@gl-admin/assets/styles/components/users/invitations.scss"

interface RemoveMemberModalProps {
    member: User | null
    me: Pick<User, "id"> | null | undefined
    onClose: () => void
    onRemoved: (member: User, recipient: User, postsReassigned: number) => void
}

// Remove member (#333): asks who receives the posts and media they own (MemberPicker,
// the picker a post's Transfer uses too, #353), then DELETE /users/:id with
// transfer_to_id. The API does it in one transaction (the same reassignment a transfer
// runs), signs them out everywhere and closes their open documents.
export default function RemoveMemberModal({ member, me, onClose, onRemoved }: RemoveMemberModalProps) {
    const [recipient, setRecipient] = useState<User | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    // Keyed by id, not the object: authManager hands out a new user object on every
    // refresh, which must not reset a recipient already picked.
    const meId = me?.id ?? null

    useEffect(() => {
        setRecipient(null)
        setError(null)
        setSaving(false)
    }, [member])

    if (!member) return null
    const name = memberName(member)

    const remove = async () => {
        if (!recipient) {
            setError("Choose who receives their posts.")
            return
        }
        setError(null)
        setSaving(true)
        try {
            const { posts_reassigned } = await deleteUser(member.id, recipient.id)
            onRemoved(member, recipient, posts_reassigned ?? 0)
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
                    <Button variant="danger" size="lg" loading={saving} disabled={!recipient} onClick={remove}>
                        Remove member
                    </Button>
                </>
            }
        >
            <div className="gl-invite-form">
                <MemberPicker
                    // A fresh load for each member removed.
                    key={member.id}
                    label={reassignSummary(member)}
                    value={recipient?.id ?? null}
                    onChange={setRecipient}
                    me={me}
                    exclude={[member.id]}
                    disabled={saving}
                    // You by default.
                    onLoaded={(members) => {
                        const mine = members.find((m) => m.id === meId && m.id !== member.id)
                        if (mine) setRecipient((current) => current ?? mine)
                    }}
                />
                {error && (
                    <Notice tone="danger" live="alert">
                        {error}
                    </Notice>
                )}
            </div>
        </Modal>
    )
}
