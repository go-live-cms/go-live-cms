import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { getMediaPosts } from "@gl-admin/lib/api/media"
import { usedInHeading, usedInRows, type UsedInRow } from "@gl-admin/lib/mediaLibrary"
import { PostStatusPill } from "@gl-admin/components/ui/PostStatus"
import Skeleton from "@gl-admin/components/ui/Skeleton"

// Loads the posts that link media `mediaId` (GET /media/:id/posts). `rows` is null while
// loading and on failure. `reload` changes refetch it.
export function useUsedIn(mediaId: number | null, reload = 0): { rows: UsedInRow[] | null; failed: boolean } {
  const [rows, setRows] = useState<UsedInRow[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (mediaId === null) return
    let live = true
    setRows(null)
    setFailed(false)
    getMediaPosts(mediaId)
      .then((links) => live && setRows(usedInRows(links)))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [mediaId, reload])

  return { rows, failed }
}

type UsedInProps = {
  rows: UsedInRow[] | null
  failed: boolean
  // The panel's compact list (title only) or the detail page's (title, how, status).
  compact?: boolean
}

// "Used in": each post linking the file, opening it in the editor.
export default function UsedIn({ rows, failed, compact = false }: UsedInProps) {
  const heading = rows ? (compact ? "Used in" : usedInHeading(rows.length)) : "Used in"

  return (
    <section className={`gl-used-in${compact ? " gl-used-in--compact" : ""}`} aria-labelledby="used-in-heading">
      <h3 id="used-in-heading" className="gl-used-in__heading">
        {heading}
      </h3>
      {failed ? (
        <p className="gl-used-in__note">Couldn't load where this file is used.</p>
      ) : rows === null ? (
        <div aria-busy="true" className="gl-used-in__loading">
          <Skeleton shape="text" width="70%" />
          <Skeleton shape="text" width="50%" />
          <span className="gl-media-sr" role="status">
            Loading where this file is used…
          </span>
        </div>
      ) : rows.length === 0 ? (
        <p className="gl-used-in__note">No post or page uses this file yet.</p>
      ) : (
        <ul className="gl-used-in__list">
          {rows.map((row) => (
            <li key={row.key}>
              <Link to={`/content/edit/${row.postId}`} className="gl-used-in__link">
                <span className="gl-used-in__text">
                  <span className="gl-used-in__title">{row.title}</span>
                  {!compact && <span className="gl-used-in__how">{row.how}</span>}
                </span>
                {!compact && row.status && <PostStatusPill status={row.status} />}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
