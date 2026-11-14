import React from "react"
import type { BlockComponentProps } from "../types"
import { useSiteRenderContext } from "../utils/siteContext"

/** Site tagline (#488): Settings › General's tagline as `p.site-tagline`; nothing without one, or outside a template. */
const SiteTaglineBlock: React.FC<BlockComponentProps> = ({ anchorId }) => {
  const site = useSiteRenderContext()
  if (!site || !site.site.tagline) return null
  return (
    <p id={anchorId} className="site-tagline">
      {site.site.tagline}
    </p>
  )
}

export default SiteTaglineBlock