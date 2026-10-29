import { AvatarStack } from "@gl-admin/components/ui/Avatar"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import { editedPhrase, formatLastEdited, lastEdited } from "@gl-admin/lib/contentList"
import { formatFullDate } from "@gl-admin/utils/formatting"
import type { Post } from "@gl-admin/lib/api/types"

// Small pieces the Posts, Pages and Home rows share (#340).

// The byline's avatars, from user_posts (editing them is #319). Falls back to the
// owner when a row has no authors.
export function Byline({ post, size = 24 }: { post: Post | null; size?: 20 | 24 }) {
  if (!post) return <Skeleton shape="circle" width={size} height={size} />
  const authors = post.authors?.length
    ? post.authors.map((a) => ({ id: a.id, name: a.full_name || a.username }))
    : [{ id: post.user_id, name: post.username }]
  return <AvatarStack users={authors} size={size} label={`Authors: ${authors.map((a) => a.name).join(", ")}`} />
}

// `phrase` reads "Edited 2 hours ago" instead of "2 hours ago".
export function LastEdited({ post, phrase = false }: { post: Post | null; phrase?: boolean }) {
  if (!post) return <Skeleton shape="text" width={72} />
  const iso = lastEdited(post)
  return (
    <time className="gl-last-edited" dateTime={iso} title={formatFullDate(iso)}>
      {phrase ? editedPhrase(iso) : formatLastEdited(iso)}
    </time>
  )
}
