import { capitalize } from "@gl-admin/utils/formatting"
import Pill, { type PillTone } from "@gl-admin/components/ui/Pill"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import { useSiteDateSettings } from "@gl-admin/lib/hooks/useSiteSettings"
import { scheduledPillLabel } from "@gl-admin/lib/schedule"

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
}: Omit<StatusProps, "status" | "withTime"> & { status: string | null; iconPath: string | null }) {
  if (!status || !iconPath) {
    return <Skeleton shape="pill" />
  }

  return <PostStatusPill status={status} unpublishedChanges={unpublishedChanges} publishAt={publishAt} />
}

// The pill alone, for places that always have the status (the editor's top bar).
export function PostStatusPill({ status, unpublishedChanges = false, publishAt, withTime }: StatusProps) {
  if (unpublishedChanges && status === "published") return <Pill tone="accent">{UNPUBLISHED_CHANGES_LABEL}</Pill>
  if (status === "scheduled" && publishAt) return <ScheduledPill publishAt={publishAt} withTime={withTime} />
  return <Pill tone={TONES[status] ?? "neutral"}>{capitalize(status)}</Pill>
}

function ScheduledPill({ publishAt, withTime }: { publishAt: string; withTime?: boolean }) {
  const settings = useSiteDateSettings()
  return (
    <Pill tone="info">
      {settings.loaded ? scheduledPillLabel(publishAt, settings, { withTime }) : "Scheduled"}
    </Pill>
  )
}
