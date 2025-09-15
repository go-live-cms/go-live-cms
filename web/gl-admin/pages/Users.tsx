import React, { useCallback, useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import Listing from "@gl-admin/layouts/Listing"
import Pagination from "@gl-admin/components/ui/Pagination"
import Username from "@gl-admin/components/ui/Username"
import DateTime from "@gl-admin/components/ui/DateTime"
import Button from "@gl-admin/components/ui/Button"
import Icon from "@gl-admin/components/ui/Icon"
import FilterSelect from "@gl-admin/components/ui/FilterSelect"
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table"
import { getUsers } from "@gl-admin/lib/api/users"
import type { User, ApiMeta } from "@gl-admin/lib/api/types"
import { AuthManager } from "@gl-admin/lib/auth"

const Users: React.FC = () => {
    const accessToken = AuthManager.getInstance().getAccessToken() || ""
    const navigate = useNavigate()
    const { baseTitle } = useGoLive()
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
        },
        {
            key: "created_at",
            name: "Created At",
            width: "10.75rem",
            render: (_, row) => <DateTime value={row?.created_at || null} />,
        }
    ]

    const clearFilters = () => {
        setSelectedFilters({ user_id: "", status: "", type: "", sort: "" })
    }

    const handleRowDoubleClick = (user: User) => {
        navigate(`/user/edit/${user.id}`)
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
                    { label: "Admin", value: "admin" },
                    { label: "Moderator", value: "moderator" },
                    { label: "Author", value: "author" },
                    { label: "Editor", value: "editor" },
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
            <Button onClick={() => navigate("/users/new")} className="gl-admin-media__new-media-btn">
                <Icon name="add" color="#000000" width="14" height="14" /> New User
            </Button>
        </>
    )

    return (
        <Listing title="Users" actions={actions}>
            <Pagination fetchData={fetchData} token={accessToken} query={selectedFilters || {}}>
                {({ data, loading }) => (
                    <Table columns={columns} data={data} loading={loading} onRowDoubleClick={handleRowDoubleClick} />
                )}
            </Pagination>
        </Listing>
    )
}

export default Users