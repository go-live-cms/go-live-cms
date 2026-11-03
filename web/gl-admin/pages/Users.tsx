import React, { useCallback, useState, useEffect, useMemo } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import Pagination from "@gl-admin/components/ui/Pagination"
import UserRole from "@gl-admin/components/ui/UserRole"
import Avatar from "@gl-admin/components/ui/Avatar"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import Button, { IconButton } from "@gl-admin/components/ui/Button"
import FilterSelect from "@gl-admin/components/ui/FilterSelect"
import Menu, { MenuItem, MenuSeparator } from "@gl-admin/components/ui/Menu"
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import { ChevronDownIcon, MoreIcon, PlusIcon, SearchIcon } from "@gl-admin/components/ui/icons"
import { getUsers } from "@gl-admin/lib/api/users"
import type { User, ApiMeta } from "@gl-admin/lib/api/types"
import { AuthManager, authManager } from "@gl-admin/lib/auth"
import { useAuthUser } from "@gl-admin/lib/hooks/useAuthUser"
import { USER_ROLE_OPTIONS, roleLabel } from "@gl-admin/lib/roles"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { canRemoveMember, lastActiveLabel, memberName, removedNotice, roleChangedNotice } from "@gl-admin/lib/members"
import { formatDate, plural } from "@gl-admin/utils/formatting"
import InviteUserModal from "@gl-admin/components/users/InviteUserModal"
import PendingInvitations from "@gl-admin/components/users/PendingInvitations"
import ChangeRoleModal from "@gl-admin/components/users/ChangeRoleModal"
import RemoveMemberModal from "@gl-admin/components/users/RemoveMemberModal"
import { ToastContainer, useToast } from "@gl-admin/components/Toast"
import { invitationSentNotice } from "@gl-admin/lib/invitations"
import type { InvitationResult } from "@gl-admin/lib/api/invitations"
import "@gl-admin/assets/styles/pages/workspace.scss"

// Users (#148, restyled in #343, the "Users · invite" board). The route is admin-only
// (AdminOnly in app.tsx), like every user-management endpoint (requireSiteAdmin).
//
// #333: member search (name, username or email; GET /users?q=), the Posts owned and
// Last active columns, and the row menu: Change role (also the role cell's button) and
// Remove, which asks who receives their posts. The rules are lib/members.ts.

// How long the search box waits for typing to stop before it searches.
const SEARCH_DEBOUNCE_MS = 250

const SORT_OPTIONS = [
    { label: "Default", value: "" },
    { label: "Newest first", value: "date_desc" },
    { label: "Oldest first", value: "date_asc" },
    { label: "Username A–Z", value: "username_asc" },
    { label: "Username Z–A", value: "username_desc" },
    { label: "Role A–Z", value: "role_asc" },
    { label: "Role Z–A", value: "role_desc" },
]

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
    const me = useAuthUser()
    const initialFilters = { role: "", sort: "" }
    const [selectedFilters, setSelectedFilters] = useState<Record<string, string>>(initialFilters)
    const [searchText, setSearchText] = useState("")
    const [search, setSearch] = useState("")
    const filtered = selectedFilters.role !== "" || selectedFilters.sort !== "" || search !== ""
    // Bumped after a role change or a removal, so the list reloads.
    const [reloadKey, setReloadKey] = useState(0)
    const [roleTarget, setRoleTarget] = useState<User | null>(null)
    const [removeTarget, setRemoveTarget] = useState<User | null>(null)

    useEffect(() => {
        const timer = setTimeout(() => setSearch(searchText.trim()), SEARCH_DEBOUNCE_MS)
        return () => clearTimeout(timer)
    }, [searchText])

    const query = useMemo(() => ({ ...selectedFilters, q: search }), [selectedFilters, search])

    const roleChanged = (user: User) => {
        setRoleTarget(null)
        showSuccess(roleChangedNotice(user))
        setReloadKey((k) => k + 1)
        // Your own role: the sidebar and the admin-only pages follow it.
        if (me && user.id === me.id) void authManager.refreshUser()
    }

    const removed = (member: User, recipient: User, moved: number) => {
        setRemoveTarget(null)
        // A filtered reload doesn't update the count, so take the member off it here.
        setMemberCount((n) => (n === null ? n : n - 1))
        showSuccess(removedNotice(member, recipient, moved), 6000)
        setReloadKey((k) => k + 1)
    }

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
            render: (_, row) =>
                row ? (
                    <button
                        type="button"
                        className="gl-member__role"
                        aria-label={`Role for ${memberName(row)}: ${roleLabel(row.role)}. Change role`}
                        onClick={() => setRoleTarget(row)}
                    >
                        <UserRole role={row.role} />
                        <ChevronDownIcon />
                    </button>
                ) : (
                    <UserRole role={null} />
                ),
        },
        {
            key: "posts_owned",
            name: "Posts owned",
            width: "7rem",
            render: (_, row) =>
                row ? <span className="gl-workspace__muted">{row.posts_owned ?? 0}</span> : <Skeleton shape="text" width={24} />,
        },
        {
            key: "last_active_at",
            name: "Last active",
            width: "9rem",
            render: (_, row) =>
                row ? (
                    <span className="gl-workspace__muted" title={row.last_active_at ? formatDate(row.last_active_at) : undefined}>
                        {lastActiveLabel(row.last_active_at)}
                    </span>
                ) : (
                    <Skeleton shape="text" width={80} />
                ),
        },
        {
            key: "id",
            name: "Actions",
            width: "3.5rem",
            render: (_, row) =>
                row && (
                    <Menu
                        label={`Actions for ${memberName(row)}`}
                        placement="bottom-end"
                        trigger={(props) => (
                            <IconButton {...props} size="sm" aria-label={`More for ${memberName(row)}`} icon={<MoreIcon />} />
                        )}
                    >
                        <MenuItem onSelect={() => navigate(`/users/edit/${row.id}`)}>Edit details</MenuItem>
                        <MenuItem onSelect={() => setRoleTarget(row)}>Change role</MenuItem>
                        <MenuSeparator />
                        <MenuItem
                            danger
                            disabled={!canRemoveMember(row, me)}
                            description={canRemoveMember(row, me) ? "Their posts go to someone you choose" : "Another administrator can remove you"}
                            onSelect={() => setRemoveTarget(row)}
                        >
                            Remove
                        </MenuItem>
                    </Menu>
                ),
        },
    ]

    const clearFilters = () => {
        setSelectedFilters(initialFilters)
        setSearchText("")
        setSearch("")
    }

    const fetchData = useCallback(
        async (args: ApiMeta & Record<string, string>, token?: string) => {
            const { limit, offset, ...query } = args
            const response = await getUsers({ limit, offset, ...query }, token || "")
            const total = response.meta.total ?? 0
            // The unfiltered total is the member count in the subtitle.
            if (!query.role && !query.q) setMemberCount(total)
            return { data: response.data, total }
        },
        // A new function reloads the page (Pagination refetches when it changes).
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [reloadKey]
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
            <ChangeRoleModal member={roleTarget} me={me} onClose={() => setRoleTarget(null)} onChanged={roleChanged} />
            <RemoveMemberModal member={removeTarget} me={me} onClose={() => setRemoveTarget(null)} onRemoved={removed} />
            <ToastContainer toasts={toasts} onRemoveToast={removeToast} />

            <section className="gl-workspace__section" aria-labelledby="gl-members-title">
                <div className="gl-workspace__section-head">
                    <h2 className="gl-workspace__section-title" id="gl-members-title">
                        Members
                    </h2>
                    <label className="gl-users__search">
                        <SearchIcon />
                        <span className="gl-workspace__sr">Search members</span>
                        <input
                            type="search"
                            placeholder="Search members"
                            value={searchText}
                            maxLength={100}
                            onChange={(e) => setSearchText(e.currentTarget.value)}
                        />
                    </label>
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
                <Pagination fetchData={fetchData} token={accessToken} query={query}>
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
                            return selectedFilters.role || search ? (
                                <EmptyState
                                    icon="search"
                                    title={search ? `No members match “${search}”` : "No users match these filters"}
                                    description={search ? "Search looks at names, usernames and emails." : "Try another role, or clear the filters."}
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
