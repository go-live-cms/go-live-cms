import { useEffect, useState } from "react"
import RadioGroup from "@gl-admin/components/ui/RadioGroup"
import Notice from "@gl-admin/components/ui/Notice"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import { getMyNotifications, updateMyNotifications, type UserNotifications } from "@gl-admin/lib/api/users"
import {
  COMMENTS_ON_POSTS_OPTIONS,
  COMMENTS_TO_MODERATE_OPTIONS,
  isCommentsOnPosts,
  isCommentsToModerate,
  notificationsSavedMessage,
} from "@gl-admin/lib/notifications"

type Field = "comments_on_posts" | "comments_to_moderate"

/**
 * Profile's Notifications (#528, reader comments design 8.3): which reader-comment mail the
 * member gets. Each choice saves at once (like the editor's Discussion section) and says so in
 * a status line; a failed save puts the choice back. "Comments to moderate" shows for editors
 * and admins only: contributors have no Discussion (decision 3).
 */
export default function NotificationsSection() {
  const [prefs, setPrefs] = useState<UserNotifications | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState<Field | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getMyNotifications()
      .then((answer) => {
        if (!cancelled) setPrefs(answer)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function choose(field: Field, value: string) {
    if (!prefs || saving) return
    if (field === "comments_on_posts" ? !isCommentsOnPosts(value) : !isCommentsToModerate(value)) return
    const before = prefs
    const next = { ...prefs, [field]: value } as UserNotifications
    setPrefs(next)
    setSaving(field)
    setStatus(null)
    setError(null)
    try {
      const saved = await updateMyNotifications({ comments_on_posts: next.comments_on_posts, comments_to_moderate: next.comments_to_moderate })
      setPrefs(saved)
      setStatus(notificationsSavedMessage(field, saved[field]))
    } catch {
      setPrefs(before)
      setError("Your choice wasn't saved. Try again.")
    } finally {
      setSaving(null)
    }
  }

  return (
    <section className="gl-workspace__section" aria-labelledby="gl-profile-notifications">
      <div>
        <h2 className="gl-workspace__section-title" id="gl-profile-notifications">
          Notifications
        </h2>
        <p className="gl-workspace__section-intro">Email about readers' comments.</p>
      </div>
      {loadFailed && (
        <Notice tone="danger" live="none">
          Your notification settings couldn't be loaded. Reload the page to try again.
        </Notice>
      )}
      {!prefs && !loadFailed && <Skeleton height={120} />}
      {prefs && (
        <div className="gl-workspace__fields">
          <RadioGroup
            legend="Comments on my posts"
            name="comments_on_posts"
            options={COMMENTS_ON_POSTS_OPTIONS}
            value={prefs.comments_on_posts}
            disabled={saving !== null}
            onChange={(value) => choose("comments_on_posts", value)}
          />
          {prefs.moderates && (
            <RadioGroup
              legend="Comments to moderate"
              name="comments_to_moderate"
              options={COMMENTS_TO_MODERATE_OPTIONS}
              value={prefs.comments_to_moderate}
              disabled={saving !== null}
              onChange={(value) => choose("comments_to_moderate", value)}
            />
          )}
        </div>
      )}
      {error && (
        <Notice tone="danger" live="alert">
          {error}
        </Notice>
      )}
      {status && (
        <Notice tone="info" live="status">
          {status}
        </Notice>
      )}
    </section>
  )
}