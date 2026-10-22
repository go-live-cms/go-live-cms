import React, { useCallback, useEffect, useState } from "react"
import Button from "@gl-admin/components/ui/Button"
import UserRole from "@gl-admin/components/ui/UserRole"
import {
    listInvitations,
    resendInvitation,
    revokeInvitation,
    type Invitation,
    type InvitationResult,
} from "@gl-admin/lib/api/invitations"
import { describeExpiry, describeInvitationError } from "@gl-admin/lib/invitations"
import "@gl-admin/assets/styles/components/users/invitations.scss"

interface PendingInvitationsProps {
    // Bump to reload (after a new invitation).
    refreshKey: number
    onResent: (result: InvitationResult) => void
    onError: (message: string) => void
    onRevoked: (invitation: Invitation) => void
}

// Open invitations (pending or expired) with resend and revoke (#148).
// Renders nothing when there are none.
const PendingInvitations: React.FC<PendingInvitationsProps> = ({ refreshKey, onResent, onError, onRevoked }) => {
    const [invitations, setInvitations] = useState<Invitation[]>([])
    const [busyId, setBusyId] = useState<number | null>(null)

    const load = useCallback(async () => {
        try {
            setInvitations(await listInvitations())
        } catch (err) {
            onError(`Couldn't load invitations. ${describeInvitationError(err)}`)
        }
    }, [onError])

    useEffect(() => {
        void load()
    }, [load, refreshKey])

    const act = async (invitation: Invitation, action: "resend" | "revoke") => {
        setBusyId(invitation.id)
        try {
            if (action === "resend") {
                onResent(await resendInvitation(invitation.id))
            } else {
                await revokeInvitation(invitation.id)
                onRevoked(invitation)
            }
        } catch (err) {
            onError(describeInvitationError(err))
        } finally {
            setBusyId(null)
            void load()
        }
    }

    if (invitations.length === 0) return null

    return (
        <section className="gl-invitations" aria-labelledby="gl-invitations-title">
            <h2 className="gl-invitations__title" id="gl-invitations-title">
                Pending invitations
            </h2>
            <ul className="gl-invitations__list">
                {invitations.map((invitation) => (
                    <li className="gl-invitations__item" key={invitation.id}>
                        <span className="gl-invitations__email">{invitation.email}</span>
                        <UserRole role={invitation.role} />
                        <span
                            className={`gl-invitations__expiry${invitation.status === "expired" ? " is-expired" : ""}`}
                        >
                            {describeExpiry(invitation)}
                        </span>
                        <span className="gl-invitations__actions">
                            <Button
                                variation="flat"
                                disabled={busyId === invitation.id}
                                onClick={() => act(invitation, "resend")}
                                aria-label={`Resend invitation to ${invitation.email}`}
                            >
                                Resend
                            </Button>
                            <Button
                                variation="danger"
                                disabled={busyId === invitation.id}
                                onClick={() => act(invitation, "revoke")}
                                aria-label={`Revoke invitation to ${invitation.email}`}
                            >
                                Revoke
                            </Button>
                        </span>
                    </li>
                ))}
            </ul>
        </section>
    )
}

export default PendingInvitations
