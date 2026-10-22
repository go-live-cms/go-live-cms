import React, { useEffect, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Input from "@gl-admin/components/ui/Input"
import Select from "@gl-admin/components/ui/Select"
import Button from "@gl-admin/components/ui/Button"
import { createInvitation, type InvitationResult, type InvitationRole } from "@gl-admin/lib/api/invitations"
import { describeInvitationError, validateInvitation } from "@gl-admin/lib/invitations"
import { USER_ROLE_OPTIONS } from "@gl-admin/lib/roles"
import "@gl-admin/assets/styles/components/users/invitations.scss"

interface InviteUserModalProps {
    isOpen: boolean
    onClose: () => void
    onInvited: (result: InvitationResult) => void
}

// Invites someone by email with a role (#148). They get a link to choose
// their own username and password; the admin never sees or sets either.
const InviteUserModal: React.FC<InviteUserModalProps> = ({ isOpen, onClose, onInvited }) => {
    const [email, setEmail] = useState("")
    const [role, setRole] = useState<string>("contributor")
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        if (isOpen) {
            setEmail("")
            setRole("contributor")
            setError(null)
            setSaving(false)
        }
    }, [isOpen])

    const submit = async (e: React.FormEvent) => {
        e.preventDefault()
        const invalid = validateInvitation(email, role)
        if (invalid) {
            setError(invalid)
            return
        }
        setError(null)
        setSaving(true)
        try {
            const result = await createInvitation({ email: email.trim(), role: role as InvitationRole })
            onInvited(result)
        } catch (err) {
            setError(describeInvitationError(err))
            setSaving(false)
        }
    }

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Invite user" size="small">
            <form className="gl-invite-form" onSubmit={submit} noValidate>
                <p className="gl-invite-form__hint">
                    They'll get an email with a link to choose their username and password. The link expires and works once.
                </p>
                <Input
                    title="Email"
                    type="email"
                    name="email"
                    value={email}
                    autoComplete="off"
                    onChange={(e: any) => setEmail(e.currentTarget?.value ?? e.target?.value ?? "")}
                />
                <Select label="Role" options={USER_ROLE_OPTIONS} value={role} onChange={setRole} bordered />
                {error && (
                    <p className="gl-invite-form__error" role="alert">
                        {error}
                    </p>
                )}
                <div className="gl-invite-form__actions">
                    <Button variation="flat" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button variation="primary" type="submit" disabled={saving} aria-busy={saving}>
                        {saving ? "Sending…" : "Send invitation"}
                    </Button>
                </div>
            </form>
        </Modal>
    )
}

export default InviteUserModal
