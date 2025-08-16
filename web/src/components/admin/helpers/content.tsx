import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import Table, { type TableColumnWithRender } from "@/components/admin/ui/Table";
import Pagination from "@/components/admin/ui/Pagination";
import PostTitle from "@/components/admin/ui/PostTitle";
import PostDateTime from "../ui/PostDateTime";
import type { Post } from "@/lib/types";

const columns: TableColumnWithRender<Post>[] = [
  { key: "title", name: "Post", width: "34.8125rem", render: (_, row) => <PostTitle value={row} /> },
  { key: "created_at", name: "Created at", width: "10.75rem", render: (_, row) => <PostDateTime value={row.created_at} /> },
];


const AdminContent: React.FC = () => {

  const [query, setQuery] = useState({});

  return (
    <>
      <Pagination
        fetchData={async ({ limit, offset }) => {
          const response = await api.getPosts({ limit, offset });
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

export default AdminContent;