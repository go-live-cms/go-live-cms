import React, { useState } from "react";
import { api } from "@gl-admin/lib/api";
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table";
import Pagination from "@gl-admin/components/ui/Pagination";
import PostTitle from "@gl-admin/components/ui/PostTitle";
import PostDateTime from "@gl-admin/components/ui/PostDateTime";
import type { Post } from "@gl-admin/lib/types";

const columns: TableColumnWithRender<Post>[] = [
    { key: "title", name: "Post", width: "34.8125rem", render: (_, row) => <PostTitle value={row} /> },
    { key: "created_at", name: "Created at", width: "10.75rem", render: (_, row) => <PostDateTime value={row.created_at} /> },
];

type ContentProps = {
    query?: Record<string, any>;
};

const Content: React.FC<ContentProps> = ({ query: queryProp }) => {

    const [query, setQuery] = useState(queryProp ?? {});

    return (
        <>
            <Pagination
                fetchData={async ({ limit, offset, type }) => {
                    const response = await api.getPosts({ limit, offset, type });
                    return { data: response.data, total: response.meta.total };
                }}
                query={query}
            >
                {(data) => (
                    <Table columns={columns} data={data} />
                )}
            </Pagination>
        </>
    );
};

export default Content;