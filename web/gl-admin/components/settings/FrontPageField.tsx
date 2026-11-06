import { useEffect, useState } from "react"
import { Select } from "@gl-admin/components/ui/Select"
import { getPostById, getPosts } from "@gl-admin/lib/api/posts"
import { frontPageHint, frontPageOptions, fromFrontPageValue, toFrontPageValue } from "@gl-admin/lib/frontPage"
import type { Post } from "@gl-admin/lib/api/types"

// Settings › General's "Front page" (#336): your latest posts, or one of the published
// pages. A chosen page that was unpublished or trashed since stays shown, with why the
// home page lists the latest posts. Rules and wording: lib/frontPage.ts.

// One request: a site's pages, by title. A site with more uses the Pages list's
// "Set as front page".
const PAGE_LIMIT = 100

export default function FrontPageField({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const [pages, setPages] = useState<Post[]>([])
  // The chosen page when it isn't among the published ones (its title and status).
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
  const hint = loadFailed ? { text: "Couldn't load your pages. Reload to choose one.", warning: true } : frontPageHint(value, current)
  return (
    <Select
      label="Front page"
      options={frontPageOptions(pages, current)}
      value={toFrontPageValue(value)}
      onChange={(next) => onChange(fromFrontPageValue(next))}
      hint={<span className={hint.warning ? "gl-settings__front-warning" : undefined}>{hint.text}</span>}
    />
  )
}
