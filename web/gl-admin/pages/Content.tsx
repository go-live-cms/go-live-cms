import React, { useState } from "react"
import Listing from "@gl-admin/layouts/Listing"
import { getPosts } from "@gl-admin/lib/api/posts"
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table"
import Pagination from "@gl-admin/components/ui/Pagination"
import PostTitle from "@gl-admin/components/ui/PostTitle"
import PostDateTime from "@gl-admin/components/ui/PostDateTime"
import PostStatus from "@gl-admin/components/ui/PostStatus"
import PostType from "@gl-admin/components/ui/PostType"
import FilterSelect from "@gl-admin/components/ui/FilterSelect"
import Button from "@gl-admin/components/ui/Button"
import Icon from "@gl-admin/components/ui/Icon"
import type { Post, ApiMeta } from "@gl-admin/lib/api/types"
import type { PostQueryParams } from "@gl-admin/lib/api/posts"

type ContentProps = {
    title?: string
    query?: Partial<PostQueryParams>
}

const Content: React.FC<ContentProps> = ({ query: queryProp, title }) => {

    const [selectedFilters, setSelectedFilters] = useState<Record<string, string>>({
        status: "",
        type: "",
        sort: "date_asc"
    })

    const columns: TableColumnWithRender<Post>[] = [
        { key: "title", name: "Post", width: "34.8125rem", render: (_, row) => <PostTitle value={row} /> },
        { key: "post_status", name: "Status", width: "10rem", render: (_, row) => <PostStatus status={row?.post_status || null} iconPath={row?.post_status || null} /> },
        {
            key: "created_at",
            name: "Created at",
            width: "10.75rem",
            render: (_, row) => <PostDateTime value={row?.created_at || null} />,
        },
    ]

    if (!queryProp?.type) {
        columns.push({
            key: "post_type",
            name: "Type",
            width: "10rem",
            render: (_, row) => <PostType type={row?.post_type || null} iconPath={row?.post_type || null} />,
        })
    }

    const getAddButtonName = () => {
        if (queryProp?.type === "post") {
            return "New Post"
        }
        return "New Page"
    }

    const filters = (
        <>
            <FilterSelect
                options={[
                    { label: "All status", value: "" },
                    { label: "Published", value: "published" },
                    { label: "Draft", value: "draft" },
                ]}
                prefix="View:"
                value={selectedFilters.status}
                onChange={value => setSelectedFilters({ ...selectedFilters, status: value })}
            />
            <FilterSelect
                options={[
                    { label: "All types", value: "" },
                    { label: "Posts", value: "post" },
                    { label: "Pages", value: "page" },
                ]}
                prefix="View:"
                value={selectedFilters.type}
                onChange={value => setSelectedFilters({ ...selectedFilters, type: value })}
            />
            <FilterSelect
                options={[
                    { label: "Created at", value: "date_asc" },
                    { label: "Title", value: "title_asc" },
                ]}
                value={selectedFilters.sort}
                onChange={value => setSelectedFilters({ ...selectedFilters, sort: value })}
                prefix="Sort by:"
            />
            <Button className="gl-admin-media__new-media-btn">
                <Icon name="add" color="white" width="14" height="14" /> {getAddButtonName()}
            </Button>
        </>
    )

    const getQuery = () => {
        return {
            ...queryProp,
            ...selectedFilters,
        }
    }

    const fetchData = async ({ limit, offset, ...query }: ApiMeta & PostQueryParams) => {
        const response = await getPosts({ limit, offset, with_meta: true, ...query })
        return { data: response.data, total: response.meta.total || 0 }
    }

    return (
        <Listing title={title || "Content"} actions={filters}>
            <Pagination
                fetchData={fetchData}
                query={getQuery() || {}}
            >
                {({ data, loading }) => <Table columns={columns} data={data} loading={loading} />}
            </Pagination>
        </Listing>
    )
}

export default Content