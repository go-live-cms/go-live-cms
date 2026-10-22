import React, { useCallback, useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import Listing from "@gl-admin/layouts/Listing"
import Pagination from "@gl-admin/components/ui/Pagination"
import Username from "@gl-admin/components/ui/Username"
import DateTime from "@gl-admin/components/ui/DateTime"
import UserRole from "@gl-admin/components/ui/UserRole"
import Button from "@gl-admin/components/ui/Button"
import Icon from "@gl-admin/components/ui/Icon"
import FilterSelect from "@gl-admin/components/ui/FilterSelect"
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import { getUsers } from "@gl-admin/lib/api/users"
import type { User, ApiMeta } from "@gl-admin/lib/api/types"
import { AuthManager } from "@gl-admin/lib/auth"
import { USER_ROLE_OPTIONS, isSiteAdmin } from "@gl-admin/lib/roles"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { useCurrentRole } from "@gl-admin/lib/hooks/useCurrentRole"
import InviteUserModal from "@gl-admin/components/users/InviteUserModal"
import PendingInvitations from "@gl-admin/components/users/PendingInvitations"
import { ToastContainer, useToast } from "@gl-admin/components/Toast"
import { invitationSentNotice } from "@gl-admin/lib/invitations"
import type { InvitationResult } from "@gl-admin/lib/api/invitations"

const Users: React.FC = () => {
    const accessToken = AuthManager.getInstance().getAccessToken() || ""
    const navigate = useNavigate()
    const { baseTitle } = useGoLive()
    // User management is admin-only (requireSiteAdmin in the API).
    const isAdmin = isSiteAdmin(useCurrentRole())
    const [inviteOpen, setInviteOpen] = useState(false)
    const [invitationsKey, setInvitationsKey] = useState(0)
    const { toasts, showSuccess, showError, showWarning, removeToast } = useToast()
    const showSentNotice = (result: InvitationResult) => {
        const notice = invitationSentNotice(result)
        if (notice.type === "success") showSuccess(notice.message)
        else showWarning(notice.message, 6000)
    }
    const handleInvited = (result: InvitationResult) => {
        setInviteOpen(false)
        setInvitationsKey((k) => k + 1)
        showSentNotice(result)
    }
    const showInvitationError = useCallback((message: string) => showError(message), [])
    const initialFilters = { role: "", sort: "" }
    const [selectedFilters, setSelectedFilters] = useState<Record<string, string>>(initialFilters)
    const columns: TableColumnWithRender<User>[] = [
        {
            key: "full_name",
            name: "Full Name",
            width: "25rem",
            render: (_, row) => <Username value={row || null} />,
        },
        {
            key: "email",
            name: "Email",
            width: "25rem",
        },
        {
            key: "role",
            name: "Role",
            width: "15rem",
            render: (_, row) => <UserRole role={row?.role || null} />,
        },
        {
            key: "created_at",
            name: "Created At",
            width: "10.75rem",
            render: (_, row) => <DateTime value={row?.created_at || null} />,
        }
    ]

    const clearFilters = () => {
        setSelectedFilters(initialFilters)
    }

    const handleRowDoubleClick = (user: User) => {
        navigate(`/users/edit/${user.id}`)
    }

    const fetchData = useCallback(
        async (args: ApiMeta & Record<string, string>, token?: string) => {
            const { limit, offset, ...query } = args
            const response = await getUsers({ limit, offset, ...query }, token || "")
            return {
                data: response.data,
                total: response.meta.total ?? 0
            }
        },
        []
    )

    useEffect(() => {
        document.title = `${baseTitle} Users`
    }, [])

    const actions = (
        <>
            {JSON.stringify(selectedFilters) !== JSON.stringify(initialFilters) ? (
                <div className="gl-clear-filters" onClick={clearFilters}>
                    Clear filters
                </div>
            ) : null}
            <FilterSelect
                value={selectedFilters.role}
                options={[
                    { label: "All Roles", value: "" },
                    ...USER_ROLE_OPTIONS,
                ]}
                prefix="Role:"
                onChange={(value) => setSelectedFilters((prev) => ({ ...prev, role: value }))}
            />
            <FilterSelect
                value={selectedFilters.sort}
                options={[
                    { label: "Default", value: "" },
                    { label: "Newest First", value: "date_desc" },
                    { label: "Oldest First", value: "date_asc" },
                    { label: "Username A-Z", value: "username_asc" },
                    { label: "Username Z-A", value: "username_desc" },
                    { label: "Role A-Z", value: "role_asc" },
                    { label: "Role Z-A", value: "role_desc" },
                ]}
                prefix="Sort:"
                onChange={(value) => setSelectedFilters((prev) => ({ ...prev, sort: value }))}
            />
            {isAdmin && (
                <>
                    <Button onClick={() => setInviteOpen(true)} variation="primary">
                        Invite user
                    </Button>
                    <Button onClick={() => navigate("/users/new")} className="gl-admin-media__new-media-btn">
                        <Icon name="add" color="#000000" width="14" height="14" /> New User
                    </Button>
                </>
            )}
        </>
    )

    return (
        <Listing title="Users" actions={actions}>
            {isAdmin && (
                <>
                    <PendingInvitations
                        refreshKey={invitationsKey}
                        onResent={showSentNotice}
                        onRevoked={(invitation) => showSuccess(`Invitation to ${invitation.email} revoked.`)}
                        onError={showInvitationError}
                    />
                    <InviteUserModal isOpen={inviteOpen} onClose={() => setInviteOpen(false)} onInvited={handleInvited} />
                </>
            )}
            <ToastContainer toasts={toasts} onRemoveToast={removeToast} />
            <Pagination fetchData={fetchData} token={accessToken} query={selectedFilters || {}}>
                {({ data, loading, error, retry }) => {
                    if (error) {
                        return (
                            <EmptyState
                                variant="error"
                                icon="close"
                                title="Couldn't load users"
                                description={errorMessage(error)}
                                action={
                                    <Button variation="primary" onClick={retry}>
                                        Try again
                                    </Button>
                                }
                            />
                        )
                    }
                    if (!loading && data.length === 0) {
                        return selectedFilters.role ? (
                            <EmptyState
                                icon="search"
                                title="No users match these filters"
                                description="Try another role, or clear the filters."
                                action={
                                    <Button variation="flat" onClick={clearFilters}>
                                        Clear filters
                                    </Button>
                                }
                            />
                        ) : (
                            <EmptyState
                                icon="user"
                                title="No users yet"
                                description="Invite your team: they'll get an email to set up their account."
                                action={
                                    isAdmin && (
                                        <Button variation="primary" onClick={() => setInviteOpen(true)}>
                                            <Icon name="add" color="white" width="14" height="14" /> Invite user
                                        </Button>
                                    )
                                }
                            />
                        )
                    }
                    return <Table columns={columns} data={data} loading={loading} onRowDoubleClick={handleRowDoubleClick} />
                }}
            </Pagination>
        </Listing>
    )
}

export default Users