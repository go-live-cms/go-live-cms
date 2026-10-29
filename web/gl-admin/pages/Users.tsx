import React, { useCallback, useState, useEffect } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import Pagination from "@gl-admin/components/ui/Pagination"
import UserRole from "@gl-admin/components/ui/UserRole"
import Avatar from "@gl-admin/components/ui/Avatar"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import Button from "@gl-admin/components/ui/Button"
import FilterSelect from "@gl-admin/components/ui/FilterSelect"
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import { PlusIcon } from "@gl-admin/components/ui/icons"
import { getUsers } from "@gl-admin/lib/api/users"
import type { User, ApiMeta } from "@gl-admin/lib/api/types"
import { AuthManager } from "@gl-admin/lib/auth"
import { USER_ROLE_OPTIONS } from "@gl-admin/lib/roles"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { formatDate } from "@gl-admin/utils/formatting"
import InviteUserModal from "@gl-admin/components/users/InviteUserModal"
import PendingInvitations from "@gl-admin/components/users/PendingInvitations"
import { ToastContainer, useToast } from "@gl-admin/components/Toast"
import { invitationSentNotice } from "@gl-admin/lib/invitations"
import type { InvitationResult } from "@gl-admin/lib/api/invitations"
import "@gl-admin/assets/styles/pages/workspace.scss"

// Users (#148, restyled in #343, the "Users · invite" board). The route is admin-only
// (AdminOnly in app.tsx), like every user-management endpoint (requireSiteAdmin).
//
// Hidden until their issues land (#333): member search, the Posts owned and Last
// active columns, changing a role from the list and removing a member (the row menu).
// A member's details, role included, are edited on their own page as before.

const SORT_OPTIONS = [
    { label: "Default", value: "" },
    { label: "Newest first", value: "date_desc" },
    { label: "Oldest first", value: "date_asc" },
    { label: "Username A–Z", value: "username_asc" },
    { label: "Username Z–A", value: "username_desc" },
    { label: "Role A–Z", value: "role_asc" },
    { label: "Role Z–A", value: "role_desc" },
]

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const Users: React.FC = () => {
    const accessToken = AuthManager.getInstance().getAccessToken() || ""
    const navigate = useNavigate()
    const { baseTitle } = useGoLive()
    const [inviteOpen, setInviteOpen] = useState(false)
    const [invitationsKey, setInvitationsKey] = useState(0)
    const [memberCount, setMemberCount] = useState<number | null>(null)
    const [pendingCount, setPendingCount] = useState(0)
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
    const filtered = selectedFilters.role !== "" || selectedFilters.sort !== ""

    const columns: TableColumnWithRender<User>[] = [
        {
            key: "full_name",
            name: "Name",
            render: (_, row) =>
                row ? (
                    <span className="gl-member">
                        <Avatar user={{ id: row.id, name: row.full_name || row.username }} size={28} decorative />
                        <span className="gl-member__text">
                            <Link className="gl-member__name" to={`/users/edit/${row.id}`}>
                                {row.full_name || row.username}
                            </Link>
                            <span className="gl-member__email">{row.email}</span>
                        </span>
                    </span>
                ) : (
                    <span className="gl-member">
                        <Skeleton shape="circle" width={28} height={28} />
                        <Skeleton shape="text" width={160} />
                    </span>
                ),
        },
        {
            key: "role",
            name: "Role",
            width: "10rem",
            render: (_, row) => <UserRole role={row?.role || null} />,
        },
        {
            key: "created_at",
            name: "Joined",
            width: "9rem",
            render: (_, row) =>
                row ? <span className="gl-workspace__muted">{formatDate(row.created_at)}</span> : <Skeleton shape="text" width={80} />,
        },
    ]

    const clearFilters = () => {
        setSelectedFilters(initialFilters)
    }

    const fetchData = useCallback(
        async (args: ApiMeta & Record<string, string>, token?: string) => {
            const { limit, offset, ...query } = args
            const response = await getUsers({ limit, offset, ...query }, token || "")
            const total = response.meta.total ?? 0
            // The unfiltered total is the member count in the subtitle.
            if (!query.role) setMemberCount(total)
            return { data: response.data, total }
        },
        []
    )

    useEffect(() => {
        document.title = `${baseTitle} Users`
    }, [])

    const subtitle = [
        memberCount !== null ? plural(memberCount, "member", "members") : null,
        pendingCount > 0 ? plural(pendingCount, "pending invitation", "pending invitations") : null,
    ]
        .filter(Boolean)
        .join(" · ")

    return (
        <div className="gl-workspace gl-users">
            <header className="gl-workspace__header">
                <div className="gl-workspace__heading">
                    <h1>Users</h1>
                    {subtitle && <span className="gl-workspace__subtitle">{subtitle}</span>}
                </div>
                <div className="gl-workspace__actions">
                    <Button variant="secondary" onClick={() => navigate("/users/new")}>
                        New user
                    </Button>
                    <Button variant="primary" icon={<PlusIcon />} onClick={() => setInviteOpen(true)}>
                        Invite people
                    </Button>
                </div>
            </header>

            <PendingInvitations
                refreshKey={invitationsKey}
                onResent={showSentNotice}
                onRevoked={(invitation) => showSuccess(`Invitation to ${invitation.email} revoked.`)}
                onError={showInvitationError}
                onCount={setPendingCount}
            />
            <InviteUserModal isOpen={inviteOpen} onClose={() => setInviteOpen(false)} onInvited={handleInvited} />
            <ToastContainer toasts={toasts} onRemoveToast={removeToast} />

            <section className="gl-workspace__section" aria-labelledby="gl-members-title">
                <div className="gl-workspace__section-head">
                    <h2 className="gl-workspace__section-title" id="gl-members-title">
                        Members
                    </h2>
                    {filtered && (
                        <Button variant="ghost" size="sm" onClick={clearFilters}>
                            Clear filters
                        </Button>
                    )}
                    <FilterSelect
                        value={selectedFilters.role}
                        options={[{ label: "All roles", value: "" }, ...USER_ROLE_OPTIONS]}
                        prefix="Role:"
                        onChange={(value) => setSelectedFilters((prev) => ({ ...prev, role: value }))}
                    />
                    <FilterSelect
                        value={selectedFilters.sort}
                        options={SORT_OPTIONS}
                        prefix="Sort:"
                        onChange={(value) => setSelectedFilters((prev) => ({ ...prev, sort: value }))}
                    />
                </div>
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
                                        <Button variant="primary" onClick={retry}>
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
                                        <Button variant="secondary" onClick={clearFilters}>
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
                                        <Button variant="primary" icon={<PlusIcon />} onClick={() => setInviteOpen(true)}>
                                            Invite people
                                        </Button>
                                    }
                                />
                            )
                        }
                        return (
                            <Table
                                columns={columns}
                                data={data}
                                loading={loading}
                                aria-label="Members"
                                onRowDoubleClick={(user) => navigate(`/users/edit/${user.id}`)}
                            />
                        )
                    }}
                </Pagination>
            </section>
        </div>
    )
}

export default Users
