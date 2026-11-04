import Notice from "@gl-admin/components/ui/Notice"
import Button from "@gl-admin/components/ui/Button"
import type { ScheduledUpdate } from "@gl-admin/lib/api/types"
import {
  SCHEDULED_UPDATE_EXCLUDES,
  scheduledUpdateFailureMessage,
  scheduledUpdateTitle,
  zoneCity,
} from "@gl-admin/lib/schedule"
import type { DateSettings } from "@/lib/siteDates"

// The editor's banner for a published post's scheduled update (#335, "Scheduled update"
// on the redesign canvas): "Update scheduled for Nov 3, 09:00 · later changes aren't
// included" with Reschedule and Cancel update, or, after a failed attempt, "Scheduled
// update failed" with the next retry and Update now. Editors and admins get the
// buttons; anyone else reads it.

type ScheduledUpdateNoticeProps = {
  update: ScheduledUpdate
  settings: Pick<DateSettings, "language" | "timeZone">
  canPublish: boolean
  onReschedule: () => void
  onCancel: () => void
  onUpdateNow: () => void
  // Update now and Reschedule need the collab server (as Update does).
  connected: boolean
  isUpdating?: boolean
  now?: Date
}

export default function ScheduledUpdateNotice({
  update,
  settings,
  canPublish,
  onReschedule,
  onCancel,
  onUpdateNow,
  connected,
  isUpdating = false,
  now = new Date(),
}: ScheduledUpdateNoticeProps) {
  if (update.failure) {
    return (
      <Notice
        tone="danger"
        live="alert"
        inline
        className="post-editor__banner"
        title="Scheduled update failed"
        actions={
          canPublish ? (
            <>
              <Button variant="secondary" size="sm" onClick={onUpdateNow} loading={isUpdating} disabled={!connected}>
                Update now
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancel update
              </Button>
            </>
          ) : undefined
        }
      >
        {scheduledUpdateFailureMessage(update.failure, settings, now)}
      </Notice>
    )
  }
  return (
    <Notice
      tone="info"
      live="status"
      inline
      className="post-editor__banner"
      title={scheduledUpdateTitle(update.update_at, settings, now)}
      actions={
        canPublish ? (
          <>
            <Button variant="secondary" size="sm" onClick={onReschedule} disabled={!connected}>
              Reschedule
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel update
            </Button>
          </>
        ) : undefined
      }
    >
      {canPublish
        ? `${zoneCity(settings.timeZone)} time · ${SCHEDULED_UPDATE_EXCLUDES}; reschedule to include them.`
        : `An editor scheduled the live post's update for this time; ${SCHEDULED_UPDATE_EXCLUDES}.`}
    </Notice>
  )
}
