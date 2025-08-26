import React, { useState } from "react"
import { posts } from "@gl-admin/lib/api"
import Listing from "@gl-admin/layouts/Listing"
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table"
import Pagination from "@gl-admin/components/ui/Pagination"
import PostTitle from "@gl-admin/components/ui/PostTitle"
import PostDateTime from "@gl-admin/components/ui/PostDateTime"
import type { Post, ApiMeta } from "@gl-admin/lib/types"

const columns: TableColumnWithRender<Post>[] = [
    { key: "title", name: "Post", width: "34.8125rem", render: (_, row) => <PostTitle value={row} /> },
    { key: "post_status", name: "Status", width: "10rem" },
    { key: "post_type", name: "Type", width: "10rem" },
    {
        key: "created_at",
        name: "Created at",
        width: "10.75rem",
        render: (_, row) => <PostDateTime value={row?.created_at || null} />,
    },
]

type ContentProps = {
    title?: string
    query?: Record<string, any>
}

const Content: React.FC<ContentProps> = ({ query: queryProp, title }) => {
    const fetchData = async ({ limit, offset, ...query }: ApiMeta) => {
        const response = await posts.getAll({ limit, offset, with_meta: true, ...query })
        return { data: response.data, total: response.meta.total }
    }

    return (
        <Listing title={title || "Content"}>
            <Pagination
                fetchData={fetchData}
                query={queryProp}
            >
                {({ data, loading }) => <Table columns={columns} data={data} loading={loading} />}
            </Pagination>
        </Listing>
    )
}

export default Content