import React from "react";
import Table, { type TableColumnWithRender } from "@/components/admin/ui/Table";
import PostTitle from "@/components/admin/ui/PostTitle";
import PostDateTime from "../ui/PostDateTime";
import type { Post } from "@/lib/types";

interface AdminContentTableProps {
  recentPosts: Post[];
}

const columns: TableColumnWithRender<Post>[] = [
  { key: "title", name: "Post", width: "34.8125rem", render: (_, row) => <PostTitle value={row} /> },
  { key: "created_at", name: "Created at", width: "10.75rem", render: (_, row) => <PostDateTime value={row.created_at} /> },
];

const AdminContent: React.FC<AdminContentTableProps> = ({ recentPosts }) => (
  <Table
    columns={columns}
    data={recentPosts}
  />
);

export default AdminContent;