import { useCallback, useEffect, useRef, useState } from "react"
import SegmentedControl from "@gl-admin/components/ui/SegmentedControl"
import Button from "@gl-admin/components/ui/Button"
import { getSettings } from "@gl-admin/lib/api/settings"
import { getPostTypeByName } from "@gl-admin/lib/api/postTypes"
import { getPostDiscussion, setPostDiscussion, type PostDiscussionAnswer } from "@gl-admin/lib/api/postDiscussion"
import {
  DISCUSSION_CHOICES,
  DISCUSSION_SAVE_FAILED,
  discussionSavedMessage,
  discussionSummary,
  type DiscussionTypeInfo,
} from "@gl-admin/lib/postDiscussion"
import { formatScheduleTime } from "@gl-admin/lib/schedule"
import { useSiteDateSettings } from "@gl-admin/lib/hooks/useSiteSettings"
import type { DiscussionSite, PostDiscussion as PostDiscussionChoice } from "@/lib/discussion"

// The post's Discussion section (#527, design 12.3; the "Discussion settings, the post's
// Discussion section…" board): the last section of the settings panel's Post tab, for
// editors and admins (decision 3: contributors have no access to Discussion, and PostForm
// doesn't render it for them). Default · Open · Closed · Off, what applies now from the
// shared rule (lib/postDiscussion.ts), and a status line after a change.
//
// It saves at once (PUT /posts/:id/discussion), outside the publish snapshot: no Update,
// and it never calls the panel's onSettingsSaved, so a published post doesn't show
// "Changes not published" for it. The API purges the public cache, so the post's thread
// follows (#523).
//
// Not built yet, so not shown: "12 comments · 2 waiting" linking to Discussion filtered by
// the post (the queue and its counts are #526).

type Loaded = { site: DiscussionSite; type: DiscussionTypeInfo; answer: PostDiscussionAnswer }

type Status = { tone: "ok" | "error"; text: string } | null

export default function PostDiscussion({
  postId,
  postType,
  published,
}: {
  postId: number
  postType: string
  // On the site now: the status line says when readers see the change.
  published: boolean
}) {
  const dateSettings = useSiteDateSettings()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  // The choice being saved, shown at once; null when nothing is in flight.
  const [pending, setPending] = useState<PostDiscussionChoice | null>(null)
  const [status, setStatus] = useState<Status>(null)
  // Only the latest change's answer counts.
  const saveRef = useRef(0)

  const load = useCallback(async () => {
    setLoadFailed(false)
    try {
      const [settings, typeAnswer, answer] = await Promise.all([
        getSettings(),
        getPostTypeByName(postType).catch(() => null),
        getPostDiscussion(postId),
      ])
      const pt = typeAnswer?.post_type
      setLoaded({
        site: {
          comments_enabled: settings.comments_enabled ?? false,
          comments_close_after_days: settings.comments_close_after_days ?? 0,
        },
        // A type that no longer exists isn't served: off, as the API reads it.
        type: { label: pt?.label || postType, served: !!pt && pt.public && pt.is_active !== false, supports: pt?.supports ?? [] },
        answer,
      })
    } catch {
      setLoadFailed(true)
    }
  }, [postId, postType])

  useEffect(() => {
    void load()
  }, [load])

  const choose = async (choice: PostDiscussionChoice) => {
    if (!loaded) return
    const save = ++saveRef.current
    setPending(choice)
    setStatus(null)
    try {
      const answer = await setPostDiscussion(postId, choice)
      if (save !== saveRef.current) return
      setLoaded((prev) => (prev ? { ...prev, answer } : prev))
      setStatus({ tone: "ok", text: discussionSavedMessage(answer.discussion, published, loaded.site.comments_enabled) })
    } catch {
      if (save !== saveRef.current) return
      setStatus({ tone: "error", text: DISCUSSION_SAVE_FAILED })
    } finally {
      if (save === saveRef.current) setPending(null)
    }
  }

  const headingId = `post-discussion-${postId}-h`
  const choice = pending ?? loaded?.answer.discussion ?? "default"
  const summary = loaded
    ? discussionSummary(
        { site: loaded.site, type: loaded.type, discussion: choice, first_published_at: loaded.answer.first_published_at },
        new Date(),
        (iso) => formatScheduleTime(iso, dateSettings)
      )
    : null

  return (
    <section className="post-settings__field post-discussion" aria-labelledby={headingId}>
      <h3 id={headingId} className="post-settings__label post-discussion__title">
        Discussion
      </h3>
      {loadFailed ? (
        <div className="post-discussion__failed">
          <small className="post-settings__error">Couldn’t load the discussion settings.</small>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          <SegmentedControl
            legend="Discussion"
            hideLegend
            block
            options={DISCUSSION_CHOICES}
            value={choice}
            onChange={(value) => void choose(value)}
            disabled={!loaded}
          />
          <p className="post-discussion__now">{summary?.now ?? "Loading…"}</p>
          {summary?.why && <small className="post-settings__hint">{summary.why}</small>}
        </>
      )}
      {/* In the page from the start, empty, so a change is announced (#477). */}
      <p className="post-discussion__status" role="status">
        {status?.tone === "ok" ? status.text : ""}
      </p>
      {status?.tone === "error" && (
        <p className="post-discussion__error" role="alert">
          {status.text}
        </p>
      )}
    </section>
  )
}
