import { useEffect, useState, type ReactNode } from "react"
import { Select } from "@gl-admin/components/ui/Select"
import { getPostById, getPosts } from "@gl-admin/lib/api/posts"
import { frontPageOptions, fromFrontPageValue, toFrontPageValue } from "@gl-admin/lib/frontPage"
import type { Post } from "@gl-admin/lib/api/types"

// Settings › Discussion's "Privacy page" (#527, design 7.5, decision 12): None, or one of
// the published pages, linked as "Privacy" after the comment form's notice. A chosen page
// that was unpublished since stays shown, marked, as Settings › General's Front page does
// (FrontPageField; the same option rules, lib/frontPage.ts).

const PAGE_LIMIT = 100

export default function PrivacyPageField({
  value,
  onChange,
  error,
}: {
  value: number | null
  onChange: (id: number | null) => void
  error?: ReactNode
}) {
  const [pages, setPages] = useState<Post[]>([])
  const [chosen, setChosen] = useState<Post | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let live = true
    getPosts({ type: "page", status: "published", limit: PAGE_LIMIT, sort: "title", order: "asc" })
      .then(({ data }) => live && setPages(data))
      .catch(() => live && setLoadFailed(true))
    return () => {
      live = false
    }
  }, [])

  const listed = value != null ? pages.find((p) => p.id === value) ?? null : null
  useEffect(() => {
    if (value == null || listed) {
      setChosen(null)
      return
    }
    let live = true
    getPostById(value)
      .then(({ post }) => live && setChosen(post))
      .catch(() => live && setChosen(null))
    return () => {
      live = false
    }
  }, [value, listed])

  const current = listed ?? chosen
  const [, ...pageOptions] = frontPageOptions(pages, current)
  const options = [{ value: "", label: "None" }, ...pageOptions]
  const unpublished = current != null && current.post_status !== "published"
  const hint = loadFailed
    ? "Couldn't load your pages. Reload to choose one."
    : unpublished
      ? `“${current.title || "Untitled"}” isn’t published, so the notice links no page until it is.`
      : "Linked as “Privacy” after the notice. Published pages only."
  return (
    <Select
      label="Privacy page"
      options={options}
      value={toFrontPageValue(value)}
      onChange={(next) => onChange(fromFrontPageValue(next))}
      hint={hint}
      error={error}
    />
  )
}
