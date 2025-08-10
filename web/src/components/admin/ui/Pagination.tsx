import React, { useEffect, useState } from "react";
import Icon from "@/components/admin/ui/Icon";
import "@assets/styles/admin/ui/pagination.scss";

type PaginationProps<T, Q = Record<string, any>> = {
  fetchData: (query: Q & { limit: number; offset: number }) => Promise<{ data: T[]; total: number }>;
  query: Q;
  limitOptions?: number[];
  pageWindow?: number; // NEW: customizable number of visible page buttons
  children: (data: T[], total: number, loading: boolean) => React.ReactNode;
};


function Pagination<T, Q = Record<string, any>>({
  fetchData,
  query,
  limitOptions = [10, 25, 50, 100],
  pageWindow = 5, // NEW: default to 5
  children,
}: PaginationProps<T, Q>) {
  const [limit, setLimit] = useState(limitOptions[0]);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const navigationIconSize = "1.2rem";

  useEffect(() => {
    setOffset(0); // Reset to first page when query changes
  }, [query, limit]);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    fetchData({ ...query, limit, offset })
      .then((res) => {
        if (isMounted) {
          setData(res.data);
          setTotal(res.total);
        }
      })
      .catch(() => {
        if (isMounted) {
          setData([]);
          setTotal(0);
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });
    return () => {
      isMounted = false;
    };
  }, [fetchData, query, limit, offset]);

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit);

  // Calculate visible page numbers
  const getPageNumbers = () => {
    if (totalPages <= pageWindow) {
      return Array.from({ length: totalPages }, (_, i) => i);
    }
    let windowStart = 0;
    if (currentPage >= pageWindow) {
      windowStart = Math.floor(currentPage / pageWindow) * pageWindow;
    }
    let windowEnd = Math.min(windowStart + pageWindow - 1, totalPages - 1);
    return Array.from({ length: windowEnd - windowStart + 1 }, (_, i) => windowStart + i);
  };

  const handleLimitChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setLimit(Number(e.target.value));
    setOffset(0);
  };

  return (
    <div className="gl-pagination">
      {children(data, total, loading)}
      <div className="gl-pagination__controls">
        {/* Go to first page */}
        <button onClick={() => setOffset(0)} disabled={currentPage === 0}>
          <Icon name="double-next" reverse={true} color={currentPage === 0 ? "#B8BCBF" : "#333536"} width={navigationIconSize} height={navigationIconSize} />
        </button>

        {/* Previous page */}
        <button onClick={() => setOffset((o) => Math.max(0, o - limit))} disabled={currentPage === 0}>
          <Icon name="next" reverse={true} color={currentPage === 0 ? "#B8BCBF" : "#333536"} width={navigationIconSize} height={navigationIconSize} />
        </button>
        {/* Page numbers */}
        <div className="gl-pagination__navigation">
          {getPageNumbers().map((page) => (
            <button
              key={page}
              onClick={() => setOffset(page * limit)}
              disabled={page === currentPage}
            >
              {page + 1}
            </button>
          ))}
        </div>
        {/* Next page */}
        <button
          onClick={() => setOffset((o) => (o + limit < total ? o + limit : o))}
          disabled={currentPage >= totalPages - 1 || totalPages === 0}
        >
          <Icon name="next" color={currentPage >= totalPages - 1 || totalPages === 0 ? "#B8BCBF" : "#333536"} width={navigationIconSize} height={navigationIconSize} />
        </button>
        {/* Go to last page */}
        <button onClick={() => setOffset((totalPages - 1) * limit)} disabled={currentPage >= totalPages - 1 || totalPages === 0}>
          <Icon name="double-next" color={currentPage >= totalPages - 1 || totalPages === 0 ? "#B8BCBF" : "#333536"} width={navigationIconSize} height={navigationIconSize} />
        </button>
        {/* Results per page dropdown */}
        <div className="gl-pagination__limit">
            <span>Results per page:</span>
            <select value={limit} onChange={handleLimitChange} style={{ padding: 4, borderRadius: 4, border: "1px solid #ccc" }}>
            {limitOptions.map((option) => (
                <option key={option} value={option}>
                {option}
                </option>
            ))}
            </select>
        </div>
      </div>
    </div>
  );
}

export default Pagination;