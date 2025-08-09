import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import Table, { type TableColumnWithRender } from "@/components/admin/ui/Table";
import PostTitle from "@/components/admin/ui/PostTitle";
import PostDateTime from "../ui/PostDateTime";
import type { Post } from "@/lib/types";

const columns: TableColumnWithRender<Post>[] = [
  { key: "title", name: "Post", width: "34.8125rem", render: (_, row) => <PostTitle value={row} /> },
  { key: "created_at", name: "Created at", width: "10.75rem", render: (_, row) => <PostDateTime value={row.created_at} /> },
];


const AdminContent: React.FC = () => {

  let [totalPosts, setTotalPosts] = useState<number>(0);
  let [recentPosts, setRecentPosts] = useState<Post[]>([]);
  let [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [postsResponse] = await Promise.all([
          api.getPosts(),
        ]);

        setTotalPosts(postsResponse.meta.total);
        setRecentPosts(postsResponse.data);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to fetch admin data');
        console.error('Admin dashboard error:', e);
      }
    };
    fetchData();
  }, []);

  return (
    <Table
      columns={columns}
      data={recentPosts}
    />
  );
};

export default AdminContent;