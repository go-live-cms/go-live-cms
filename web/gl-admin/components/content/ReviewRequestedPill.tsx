import Pill from "@gl-admin/components/ui/Pill"
import { PencilIcon } from "@gl-admin/components/ui/icons"
import type { ReviewRequestSummary } from "@gl-admin/lib/api/reviewRequests"
import { reviewIndicator } from "@gl-admin/lib/reviewRequests"

// The posts list's "Review requested" indicator (#323): a row with an open review
// request. The icon tells it from the info-toned Scheduled pill without hue; who asked
// whom is in the tooltip and, for screen readers, in the text.
export default function ReviewRequestedPill({ summary, meId }: { summary: ReviewRequestSummary | null | undefined; meId: number | null | undefined }) {
  const indicator = reviewIndicator(summary, meId)
  if (!indicator) return null
  return (
    <span className="gl-review-pill" title={indicator.detail}>
      <Pill tone="info" icon={<PencilIcon size={12} />}>
        {indicator.label}
      </Pill>
      <span className="gl-content-list__sr">: {indicator.detail}</span>
    </span>
  )
}
