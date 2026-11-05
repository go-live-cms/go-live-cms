import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import type { ReviewRequest } from "@gl-admin/lib/api/reviewRequests"
import { reviewNotice, type ReviewViewer } from "@gl-admin/lib/reviewRequests"

// The editor's review banner (#323): a pending request (for its reviewers: Approve and
// publish, Request changes, Dismiss; for its requester: Withdraw), or the reviewer's
// note after changes were requested (Request review again). What it says is
// lib/reviewRequests.ts's reviewNotice. Comments (#192) aren't built, so a note is
// plain text.

type Props = {
  request: ReviewRequest | null
  viewer: ReviewViewer
  // "Approve and publish" or "Approve and update": the Publish button's path, which
  // resolves the request.
  published: boolean
  // False for an archived post: the top bar has no Publish for it (Restore to drafts
  // first), so the banner doesn't offer one either.
  publishable: boolean
  onPublish: () => void
  onRequestChanges: () => void
  onDismiss: () => void
  onRequestAgain: () => void
  // The publish needs the collab server.
  connected: boolean
  busy: boolean
}

export default function ReviewRequestNotice({ request, viewer, published, publishable, onPublish, onRequestChanges, onDismiss, onRequestAgain, connected, busy }: Props) {
  const notice = reviewNotice(request, viewer)
  if (!notice) return null

  const actions = notice.actions.filter((action) => publishable || action !== "publish").map((action) => {
    switch (action) {
      case "publish":
        return (
          <Button key={action} variant="secondary" size="sm" onClick={onPublish} disabled={!connected || busy}>
            {published ? "Approve and update" : "Approve and publish"}
          </Button>
        )
      case "request_changes":
        return (
          <Button key={action} variant="secondary" size="sm" onClick={onRequestChanges} disabled={busy}>
            Request changes
          </Button>
        )
      case "dismiss":
        return (
          <Button key={action} variant="ghost" size="sm" onClick={onDismiss} disabled={busy}>
            Dismiss
          </Button>
        )
      case "withdraw":
        return (
          <Button key={action} variant="ghost" size="sm" onClick={onDismiss} disabled={busy}>
            Withdraw request
          </Button>
        )
      case "request_again":
        return (
          <Button key={action} variant="secondary" size="sm" onClick={onRequestAgain} disabled={busy}>
            Request review again
          </Button>
        )
    }
  })

  return (
    <Notice
      tone={notice.tone}
      live="status"
      inline
      className="post-editor__banner post-editor__review"
      title={notice.title}
      actions={actions.length > 0 ? <>{actions}</> : undefined}
    >
      {notice.quoted ? <q className="post-editor__review-note">{notice.message}</q> : notice.message}
    </Notice>
  )
}
