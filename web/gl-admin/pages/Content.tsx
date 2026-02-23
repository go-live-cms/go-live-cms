import React, { useState, useEffect, useCallback } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import Listing from "@gl-admin/layouts/Listing"
import { getPosts } from "@gl-admin/lib/api/posts"
import { getUsers } from "@gl-admin/lib/api/users"
import { getPostTypes } from "@gl-admin/lib/api/postTypes"
import Table, { type TableColumnWithRender } from "@gl-admin/components/ui/Table"
import Pagination from "@gl-admin/components/ui/Pagination"
import PostTitle from "@gl-admin/components/ui/PostTitle"
import PostDateTime from "@gl-admin/components/ui/PostDateTime"
import PostStatus from "@gl-admin/components/ui/PostStatus"
import PostType from "@gl-admin/components/ui/PostType"
import FilterSelect from "@gl-admin/components/ui/FilterSelect"
import Button from "@gl-admin/components/ui/Button"
import Icon from "@gl-admin/components/ui/Icon"
import type { Post, ApiMeta, PostType as PostTypeInfo } from "@gl-admin/lib/api/types"
import type { PostQueryParams } from "@gl-admin/lib/api/posts"

type ContentProps = {
  title?: string
  query?: Partial<PostQueryParams>
}

const Content: React.FC<ContentProps> = ({ query: queryProp, title }) => {
  const navigate = useNavigate()
  const { typeName } = useParams<{ typeName?: string }>()
  const { isDark, baseTitle } = useGoLive()
  const [postTypesList, setPostTypesList] = useState<PostTypeInfo[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [authorOptions, setAuthorOptions] = useState<{ label: string; value: string }[]>([
    { label: "All authors", value: "" },
  ])
  const initialFilters = (() => {
    const base = { user_id: "", type: typeName || "", sort: "", status: "" }
    if (queryProp) {
      const stringFilters = Object.fromEntries(
        Object.entries(queryProp).map(([key, value]) => [key, value !== undefined ? String(value) : ""])
      )
      return { ...base, ...stringFilters }
    }
    return base
  })()
  const [selectedFilters, setSelectedFilters] = useState<Record<string, string>>(initialFilters)
  const getInitialColumns = () => {
    const cols: TableColumnWithRender<Post>[] = [
      { key: "title", name: "Post", width: "34.8125rem", render: (_, row) => <PostTitle value={row} /> },
      {
        key: "post_status",
        name: "Status",
        width: "10rem",
        render: (_, row) => <PostStatus status={row?.post_status || null} iconPath={row?.post_status || null} />,
      },
      {
        key: "created_at",
        name: "Created at",
        width: "10.75rem",
        render: (_, row) => <PostDateTime value={row?.created_at || null} />,
      },
    ]
    if (!queryProp && !typeName) {
      cols.push({
        key: "post_type",
        name: "Type",
        width: "10rem",
        render: (_, row) => <PostType type={row?.post_type || null} iconPath={row?.post_type || null} />,
      })
    }
    return cols
  }
  const columns: TableColumnWithRender<Post>[] = getInitialColumns()
  const iconColor = isDark ? "#000000" : "#FFFFFF"

  const getAuthorOptions = async () => {
    const authors = await getAuthors()
    const authorOptions =
      authors?.map((author) => ({
        label: author.full_name || author.username,
        value: String(author.id),
      })) || []
    return [{ label: "All authors", value: "" }, ...authorOptions]
  }

  const getAuthors = async () => {
    try {
      setLoadingUsers(true)
      const response = await getUsers()
      return response.data
    } catch (e) {
      console.error("Error loading users:", e)
    } finally {
      setLoadingUsers(false)
    }
    return []
  }

  const getAddButtonName = () => {
    const type = typeName || queryProp?.type
    if (type) {
      const pt = postTypesList.find((p) => p.name === type)
      if (pt) return `New ${pt.label.replace(/s$/, "")}`
      return `New ${type.charAt(0).toUpperCase() + type.slice(1)}`
    }
    return "New Post"
  }

  const clearFilters = () => {
    setSelectedFilters({ user_id: "", status: "", type: "", sort: "" })
  }

  const handleNewPost = () => {
    const type = typeName || queryProp?.type || "post"
    navigate(`/content/${type}/new`)
  }

  const handleRowDoubleClick = (post: Post) => {
    navigate(`/content/edit/${post.id}`)
  }

  const fetchData = useCallback(
    async ({ limit, offset, ...query }: ApiMeta & PostQueryParams) => {
      const mergedParams = {
        limit,
        offset,
        with_meta: true,
        meta_level: "basic",
        ...query,
        ...selectedFilters,
      }

      const filteredParams = Object.fromEntries(
        Object.entries(mergedParams).filter(([_, value]) => value !== "" && value !== undefined)
      )

      const response = await getPosts(filteredParams)
      return { data: response.data, total: response.meta.total || 0 }
    },
    [selectedFilters]
  )

  useEffect(() => {
    // Derive page title from route param or prop
    const pageTitle = typeName
      ? postTypesList.find((p) => p.name === typeName)?.label ||
        typeName.charAt(0).toUpperCase() + typeName.slice(1) + "s"
      : title || "Content"
    document.title = `${baseTitle} ${pageTitle}`

    const fetchAuthorOptions = async () => {
      const options = await getAuthorOptions()
      setAuthorOptions(options)
    }
    fetchAuthorOptions()

    // Fetch post types for filter dropdown
    getPostTypes()
      .then(({ data }) => {
        if (data && data.length > 0) setPostTypesList(data)
      })
      .catch(() => {})
  }, [typeName])

  const filters = (
    <>
      {selectedFilters.user_id || selectedFilters.status || selectedFilters.type || selectedFilters.sort ? (
        <div className="gl-clear-filters" onClick={clearFilters}>
          Clear filters
        </div>
      ) : null}
      <FilterSelect
        options={authorOptions}
        prefix="Author:"
        value={selectedFilters.user_id}
        loading={loadingUsers}
        onChange={(value) => setSelectedFilters({ ...selectedFilters, user_id: value })}
      />
      <FilterSelect
        options={[
          { label: "All status", value: "" },
          { label: "Published", value: "published" },
          { label: "Draft", value: "draft" },
        ]}
        prefix="View:"
        value={selectedFilters.status}
        onChange={(value) => setSelectedFilters({ ...selectedFilters, status: value })}
      />
      {!queryProp?.type && !typeName && (
        <FilterSelect
          options={[
            { label: "All types", value: "" },
            ...postTypesList.map((pt) => ({ label: pt.label, value: pt.name })),
          ]}
          prefix="View:"
          value={selectedFilters.type}
          onChange={(value) => setSelectedFilters({ ...selectedFilters, type: value })}
        />
      )}
      <FilterSelect
        options={[
          { label: "Default", value: "" },
          { label: "Newest First", value: "date_desc" },
          { label: "Oldest First", value: "date_asc" },
          { label: "Name A-Z", value: "title_asc" },
          { label: "Name Z-A", value: "title_desc" },
          { label: "Type A-Z", value: "type_asc" },
          { label: "Type Z-A", value: "type_desc" },
        ]}
        value={selectedFilters.sort}
        onChange={(value) => setSelectedFilters({ ...selectedFilters, sort: value })}
        prefix="Sort by:"
      />
      <Button onClick={handleNewPost} className="gl-admin-media__new-media-btn">
        <Icon name="add" color={iconColor} width="14" height="14" /> {getAddButtonName()}
      </Button>
    </>
  )

  const displayTitle = typeName
    ? postTypesList.find((p) => p.name === typeName)?.label ||
      typeName.charAt(0).toUpperCase() + typeName.slice(1) + "s"
    : title || "Content"

  return (
    <Listing title={displayTitle} actions={filters}>
      <Pagination fetchData={fetchData} query={selectedFilters || {}}>
        {({ data, loading }) => (
          <Table columns={columns} data={data} loading={loading} onRowDoubleClick={handleRowDoubleClick} />
        )}
      </Pagination>
    </Listing>
  )
}

export default Content
