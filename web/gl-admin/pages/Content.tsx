import React from "react"
import Listing from "@gl-admin/layouts/Listing"
import { getPosts } from "@gl-admin/lib/api/posts"
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table"
import Pagination from "@gl-admin/components/ui/Pagination"
import PostTitle from "@gl-admin/components/ui/PostTitle"
import PostDateTime from "@gl-admin/components/ui/PostDateTime"
import PostStatus from "@gl-admin/components/ui/PostStatus"
import type { Post, ApiMeta } from "@gl-admin/lib/api/types"
import type { PostQueryParams } from "@gl-admin/lib/api/posts"

const columns: TableColumnWithRender<Post>[] = [
    { key: "title", name: "Post", width: "34.8125rem", render: (_, row) => <PostTitle value={row} /> },
    { key: "post_status", name: "Status", width: "10rem", render: (_, row) => <PostStatus status={row?.post_status || null} iconPath={row?.post_status || null} /> },
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
    query?: Partial<PostQueryParams>
}

const Content: React.FC<ContentProps> = ({ query: queryProp, title }) => {
    const fetchData = async ({ limit, offset, ...query }: ApiMeta & PostQueryParams) => {
        const response = await getPosts({ limit, offset, with_meta: true, ...query })
        return { data: response.data, total: response.meta.total || 0 }
    }

    return (
        <Listing title={title || "Content"}>
            <Pagination
                fetchData={fetchData}
                query={queryProp || {}}
            >
                {({ data, loading }) => <Table columns={columns} data={data} loading={loading} />}
            </Pagination>
        </Listing>
    )
}

export default Content