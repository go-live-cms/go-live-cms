import React, { useEffect, useState } from "react"
import { useDarkMode } from "@gl-admin/contexts/DarkModeContext"
import Icon from "@gl-admin/components/ui/Icon"
import Select from "@gl-admin/components/ui/Select"
import "@gl-admin/assets/styles/components/ui/pagination.scss"
import type { ApiMeta } from "@gl-admin/lib/api/types"

type PaginationProps<T, Q> = {
  fetchData: ({ limit, offset, ...query }: ApiMeta & Q) => Promise<{ data: T[]; total: number }>
  query: Q
  limitOptions?: number[]
  pageWindow?: number
  children: (args: { data: T[], total: number, loading: boolean }) => React.ReactNode
}

function Pagination<T, Q>({
  fetchData,
  query,
  limitOptions = [8, 16, 24, 48, 64],
  pageWindow = 5,
  children,
}: PaginationProps<T, Q>) {
  const [limit, setLimit] = useState(limitOptions[0])
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const isDark = useDarkMode()
  const navIconColor = isDark ? "#FFFFFF" : "#46484A";
  const navIconDisabledColor = isDark ? "#6B7175" : "#B8BCBF"

  const navigationIconSize = "1.2rem"

  useEffect(() => {
    setOffset(0)
  }, [query, limit])

  useEffect(() => {
    let isMounted = true
    setLoading(true)
    fetchData({ limit, offset, ...query })
      .then((res) => {
        if (isMounted) {
          setData(res.data)
          setTotal(res.total)
        }
      })
      .catch(() => {
        if (isMounted) {
          setData([])
          setTotal(0)
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false)
      })
    return () => {
      isMounted = false
    }
  }, [fetchData, query, limit, offset])

  const totalPages = Math.ceil(total / limit)
  const currentPage = Math.floor(offset / limit)

  const getPageNumbers = () => {
    if (totalPages <= pageWindow) {
      return Array.from({ length: totalPages }, (_, i) => i)
    }
    let windowStart = 0
    if (currentPage >= pageWindow) {
      windowStart = Math.floor(currentPage / pageWindow) * pageWindow
    }
    let windowEnd = Math.min(windowStart + pageWindow - 1, totalPages - 1)
    return Array.from({ length: windowEnd - windowStart + 1 }, (_, i) => windowStart + i)
  }

  const handleLimitChange = (value: string) => {
    setLimit(Number(value))
    setOffset(0)
  }

  return (
    <div className="gl-pagination">
      {children({ data, total, loading })}
      {!loading &&
        <div className="gl-pagination__controls">
          {/* Go to first page */}
          <button onClick={() => setOffset(0)} disabled={currentPage === 0}>
            <Icon
              name="double-next"
              mirror_horizontally={true}
              color={currentPage === 0 ? navIconDisabledColor : navIconColor}
              width={navigationIconSize}
              height={navigationIconSize}
            />
          </button>

          {/* Previous page */}
          <button onClick={() => setOffset((o) => Math.max(0, o - limit))} disabled={currentPage === 0}>
            <Icon
              name="next"
              mirror_horizontally={true}
              color={currentPage === 0 ? navIconDisabledColor : navIconColor}
              width={navigationIconSize}
              height={navigationIconSize}
            />
          </button>

          <div className="gl-pagination__navigation">
            {getPageNumbers().map((page) => (
              <button key={page} onClick={() => setOffset(page * limit)} disabled={page === currentPage}>
                {page + 1}
              </button>
            ))}
          </div>
          {/* Next page */}
          <button
            onClick={() => setOffset((o) => (o + limit < total ? o + limit : o))}
            disabled={currentPage >= totalPages - 1 || totalPages === 0}
          >
            <Icon
              name="next"
              color={currentPage >= totalPages - 1 || totalPages === 0 ? navIconDisabledColor : navIconColor}
              width={navigationIconSize}
              height={navigationIconSize}
            />
          </button>
          {/* Go to last page */}
          <button
            onClick={() => setOffset((totalPages - 1) * limit)}
            disabled={currentPage >= totalPages - 1 || totalPages === 0}
          >
            <Icon
              name="double-next"
              color={currentPage >= totalPages - 1 || totalPages === 0 ? navIconDisabledColor : navIconColor}
              width={navigationIconSize}
              height={navigationIconSize}
            />
          </button>

          <div className="gl-pagination__limit">
            <Select
              options={limitOptions.map((option) => ({ value: String(option), label: String(option) }))}
              value={String(limit)}
              onChange={handleLimitChange}
            />
          </div>
        </div>
      }
    </div>
  )
}

export default Pagination
