import React, { useCallback, useEffect, useState } from "react"
import Button from "@gl-admin/components/ui/Button"
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table"
import UserRole from "@gl-admin/components/ui/UserRole"
import { MailIcon } from "@gl-admin/components/ui/icons"
import {
    listInvitations,
    resendInvitation,
    revokeInvitation,
    type Invitation,
    type InvitationResult,
} from "@gl-admin/lib/api/invitations"
import { describeExpiry, describeInvitationError } from "@gl-admin/lib/invitations"
import { formatDate } from "@gl-admin/utils/formatting"
import "@gl-admin/assets/styles/components/users/invitations.scss"

interface PendingInvitationsProps {
    // Bump to reload (after a new invitation).
    refreshKey: number
    onResent: (result: InvitationResult) => void
    onError: (message: string) => void
    onRevoked: (invitation: Invitation) => void
    // How many are open, for the page's subtitle.
    onCount?: (count: number) => void
}

type InvitationRow = Invitation & { actions?: null }

// Open invitations (pending or expired) with resend and revoke (#148, restyled in
// #343). Renders nothing when there are none. The board's "Invited by" needs the
// inviter's name, which the list doesn't return (only invited_by, an id).
const PendingInvitations: React.FC<PendingInvitationsProps> = ({ refreshKey, onResent, onError, onRevoked, onCount }) => {
    const [invitations, setInvitations] = useState<Invitation[]>([])
    const [busyId, setBusyId] = useState<number | null>(null)

    const load = useCallback(async () => {
        try {
            const list = await listInvitations()
            setInvitations(list)
            onCount?.(list.length)
        } catch (err) {
            onError(`Couldn't load invitations. ${describeInvitationError(err)}`)
        }
    }, [onError, onCount])

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

    const columns: TableColumnWithRender<InvitationRow>[] = [
        {
            key: "email",
            name: "Email",
            render: (_, row) =>
                row && (
                    <span className="gl-invitations__email">
                        <span className="gl-invitations__mark" aria-hidden="true">
                            <MailIcon size={14} />
                        </span>
                        {row.email}
                    </span>
                ),
        },
        { key: "role", name: "Role", width: "8rem", render: (_, row) => row && <UserRole role={row.role} /> },
        {
            key: "created_at",
            name: "Sent",
            width: "8rem",
            render: (_, row) => row && <span className="gl-invitations__sent">{formatDate(row.created_at)}</span>,
        },
        {
            key: "expires_at",
            name: "Expires",
            width: "10rem",
            render: (_, row) =>
                row && (
                    <span className={`gl-invitations__expiry${row.status === "expired" ? " is-expired" : ""}`}>
                        {describeExpiry(row)}
                    </span>
                ),
        },
        {
            key: "actions",
            name: "Actions",
            width: "11rem",
            render: (_, row) =>
                row && (
                    <span className="gl-invitations__actions">
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={busyId === row.id}
                            onClick={() => act(row, "resend")}
                            aria-label={`Resend invitation to ${row.email}`}
                        >
                            Resend
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            className="gl-button--danger-text"
                            disabled={busyId === row.id}
                            onClick={() => act(row, "revoke")}
                            aria-label={`Revoke invitation to ${row.email}`}
                        >
                            Revoke
                        </Button>
                    </span>
                ),
        },
    ]

    return (
        <section className="gl-workspace__section gl-invitations" aria-labelledby="gl-invitations-title">
            <h2 className="gl-workspace__section-title" id="gl-invitations-title">
                Pending invitations
            </h2>
            <Table<InvitationRow> columns={columns} data={invitations} aria-label="Pending invitations" />
        </section>
    )
}

export default PendingInvitations
