import React, { useEffect, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Input from "@gl-admin/components/ui/Input"
import RadioGroup from "@gl-admin/components/ui/RadioGroup"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import { createInvitation, type InvitationResult, type InvitationRole } from "@gl-admin/lib/api/invitations"
import { describeInvitationError, validateInvitation } from "@gl-admin/lib/invitations"
import { roleChoices } from "@gl-admin/lib/roles"
import "@gl-admin/assets/styles/components/users/invitations.scss"

interface InviteUserModalProps {
    isOpen: boolean
    onClose: () => void
    onInvited: (result: InvitationResult) => void
}

const FORM_ID = "gl-invite-form"

// Invites someone by email with a role (#148, restyled in #343). They get a link to
// choose their own username and password; the admin never sees or sets either.
// One address per invitation (the API takes one), and no personal message (the
// invitation email has none).
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

    const footer = (
        <div className="gl-invite-form__footer">
            <span className="gl-invite-form__note">They'll get an email with a link to join. It expires and works once.</span>
            <Button variant="secondary" size="lg" onClick={onClose} disabled={saving}>
                Cancel
            </Button>
            <Button variant="primary" size="lg" type="submit" form={FORM_ID} loading={saving}>
                Send invite
            </Button>
        </div>
    )

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Invite people" size="medium" footer={footer} closeOnBackdrop={false}>
            <form id={FORM_ID} className="gl-invite-form" onSubmit={submit} noValidate>
                <Input
                    title="Email address"
                    type="email"
                    name="email"
                    value={email}
                    autoComplete="off"
                    hint="They choose their own username and password."
                    onChange={(e: any) => setEmail(e.currentTarget?.value ?? e.target?.value ?? "")}
                />
                <RadioGroup legend="Role" variant="card" options={roleChoices()} value={role} onChange={setRole} />
                {error && (
                    <Notice tone="danger" live="alert">
                        {error}
                    </Notice>
                )}
            </form>
        </Modal>
    )
}

export default InviteUserModal
