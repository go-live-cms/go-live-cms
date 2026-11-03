import { capitalize } from "@gl-admin/utils/formatting"
import Pill, { type PillTone } from "@gl-admin/components/ui/Pill"
import Skeleton from "@gl-admin/components/ui/Skeleton"

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
}

// A post's status as a pill (#338). `iconPath` is no longer drawn (the pill has its
// dot); it stays in the signature because the tables pass null while loading.
export default function PostStatus({
  status,
  iconPath,
  unpublishedChanges,
}: Omit<StatusProps, "status"> & { status: string | null; iconPath: string | null }) {
  if (!status || !iconPath) {
    return <Skeleton shape="pill" />
  }

  return <PostStatusPill status={status} unpublishedChanges={unpublishedChanges} />
}

// The pill alone, for places that always have the status (the editor's top bar).
export function PostStatusPill({ status, unpublishedChanges = false }: StatusProps) {
  if (unpublishedChanges && status === "published") return <Pill tone="accent">{UNPUBLISHED_CHANGES_LABEL}</Pill>
  return <Pill tone={TONES[status] ?? "neutral"}>{capitalize(status)}</Pill>
}
