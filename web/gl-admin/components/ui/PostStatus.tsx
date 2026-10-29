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

// A post's status as a pill (#338). `iconPath` is no longer drawn (the pill has its
// dot); it stays in the signature because the tables pass null while loading.
export default function PostStatus({ status, iconPath }: { status: string | null; iconPath: string | null }) {
  if (!status || !iconPath) {
    return <Skeleton shape="pill" />
  }

  return <PostStatusPill status={status} />
}

// The pill alone, for places that always have the status (the editor's top bar).
export function PostStatusPill({ status }: { status: string }) {
  return <Pill tone={TONES[status] ?? "neutral"}>{capitalize(status)}</Pill>
}
