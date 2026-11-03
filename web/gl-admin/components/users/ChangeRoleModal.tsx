import { useEffect, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import RadioGroup from "@gl-admin/components/ui/RadioGroup"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import { changeUserRole } from "@gl-admin/lib/api/users"
import type { User } from "@gl-admin/lib/api/types"
import { demotesSelf, memberName, roleChangeError } from "@gl-admin/lib/members"
import { roleChoices } from "@gl-admin/lib/roles"
import "@gl-admin/assets/styles/components/users/invitations.scss"

interface ChangeRoleModalProps {
    member: User | null
    me: Pick<User, "id"> | null | undefined
    onClose: () => void
    onChanged: (user: User) => void
}

const FORM_ID = "gl-change-role-form"

// Change role, from a member's row (#333). The API refuses to demote the last admin
// (409 last_admin). The change applies at once: the API reads roles from the DB on
// every request, and the collab server re-checks their open documents.
export default function ChangeRoleModal({ member, me, onClose, onChanged }: ChangeRoleModalProps) {
    const [role, setRole] = useState("")
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        if (member) {
            setRole(member.role.toLowerCase())
            setError(null)
            setSaving(false)
        }
    }, [member])

    if (!member) return null
    const name = memberName(member)
    const unchanged = role === member.role.toLowerCase()

    const submit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (unchanged) return onClose()
        setError(null)
        setSaving(true)
        try {
            const { user } = await changeUserRole(member.id, role)
            onChanged(user)
        } catch (err) {
            setError(roleChangeError(err, member))
            setSaving(false)
        }
    }

    return (
        <Modal
            isOpen
            onClose={() => !saving && onClose()}
            title={`Change ${name}'s role`}
            description="It takes effect right away, in documents they have open too."
            size="medium"
            footer={
                <>
                    <Button variant="secondary" size="lg" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button variant="primary" size="lg" type="submit" form={FORM_ID} loading={saving} disabled={unchanged}>
                        Change role
                    </Button>
                </>
            }
        >
            <form id={FORM_ID} className="gl-invite-form" onSubmit={submit} noValidate>
                <RadioGroup legend="Role" variant="card" options={roleChoices()} value={role} onChange={setRole} />
                {demotesSelf(member, me, role) && (
                    <Notice tone="warning">You'll lose access to Users, Themes and Settings. Another administrator can give it back.</Notice>
                )}
                {error && (
                    <Notice tone="danger" live="alert">
                        {error}
                    </Notice>
                )}
            </form>
        </Modal>
    )
}
