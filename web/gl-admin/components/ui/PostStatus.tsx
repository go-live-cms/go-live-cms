import { capitalize } from "@gl-admin/utils/formatting"
import Pill, { type PillTone } from "@gl-admin/components/ui/Pill"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import { useSiteDateSettings } from "@gl-admin/lib/hooks/useSiteSettings"
import { scheduledPillLabel, UPDATE_SCHEDULED_LABEL, updateScheduledPillLabel } from "@gl-admin/lib/schedule"

const TONES: Record<string, PillTone> = {
  published: "success",
  draft: "warning",
  scheduled: "info",
  private: "neutral",
  archived: "outline",
}

// A published post whose working copy differs from the live one (#326).
export const UNPUBLISHED_CHANGES_LABEL = "Changes not published"

type StatusProps = {
  status: string
  // The post's has_unpublished_changes: a published post then reads "Changes not
  // published" instead of "Published".
  unpublishedChanges?: boolean
  // A scheduled post's publish_at (#147): the pill reads "Scheduled · Nov 3", in site time.
  publishAt?: string | null
  // A published post's scheduled update (#335, update_at): "Update scheduled · Nov 3",
  // in place of "Changes not published" (the changes are on their way).
  updateAt?: string | null
  // The editor's pill adds the time: "Scheduled · Nov 3, 09:00".
  withTime?: boolean
}

// A post's status as a pill (#338). `iconPath` is no longer drawn (the pill has its
// dot); it stays in the signature because the tables pass null while loading.
export default function PostStatus({
  status,
  iconPath,
  unpublishedChanges,
  publishAt,
  updateAt,
}: Omit<StatusProps, "status" | "withTime"> & { status: string | null; iconPath: string | null }) {
  if (!status || !iconPath) {
    return <Skeleton shape="pill" />
  }

  return <PostStatusPill status={status} unpublishedChanges={unpublishedChanges} publishAt={publishAt} updateAt={updateAt} />
}

// The pill alone, for places that always have the status (the editor's top bar).
export function PostStatusPill({ status, unpublishedChanges = false, publishAt, updateAt, withTime }: StatusProps) {
  if (status === "published" && updateAt) return <ScheduledPill at={updateAt} update withTime={withTime} />
  if (unpublishedChanges && status === "published") return <Pill tone="accent">{UNPUBLISHED_CHANGES_LABEL}</Pill>
  if (status === "scheduled" && publishAt) return <ScheduledPill at={publishAt} withTime={withTime} />
  return <Pill tone={TONES[status] ?? "neutral"}>{capitalize(status)}</Pill>
}

function ScheduledPill({ at, update = false, withTime }: { at: string; update?: boolean; withTime?: boolean }) {
  const settings = useSiteDateSettings()
  const label = update ? updateScheduledPillLabel : scheduledPillLabel
  return (
    <Pill tone="info" icon={update ? <ClockIcon /> : undefined}>
      {settings.loaded ? label(at, settings, { withTime }) : update ? UPDATE_SCHEDULED_LABEL : "Scheduled"}
    </Pill>
  )
}

const ClockIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)
