import React from "react"
import { normalizeSiteBlockAttrs } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import BlockRenderer from "../../BlockRenderer"
import { SiteContext, useSiteRenderContext, type SiteRenderContext } from "../utils/siteContext"

/**
 * Template part (#488, design 4.2, 7.5): renders the part its slug resolves to (#491: the
 * published override, the theme's part, or core's starter), its blocks through a nested
 * `BlockRenderer` that shares the page's scope (heading ids, the embed loader, #484). A header
 * is a `<header>`, a footer a `<footer>`, any other part a `<div>`, each
 * `.template-part.template-part--<slug>`.
 *
 * Nothing when the slug resolves to nothing (publish refuses that, 8.2), outside a template,
 * and inside a part: a part can't hold a part (`siteBlockKindIssues`), so a part is never
 * recursive whatever a stored doc says.
 */
const TemplatePartBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const site = useSiteRenderContext()
  if (!site || site.kind !== "template") return null
  const slug = normalizeSiteBlockAttrs("template_part", block.attrs).slug as string | undefined
  const doc = slug ? site.parts[slug] : null
  if (!slug || !doc || !Array.isArray(doc.blocks_order) || doc.blocks_order.length === 0) return null
  // The slug lets a query in the part find its posts (#489, `queryKey`).
  const inPart: SiteRenderContext = { ...site, kind: "part", partSlug: slug }
  const Tag = slug === "header" ? "header" : slug === "footer" ? "footer" : "div"
  return (
    <Tag id={anchorId} className={`template-part template-part--${slug}`}>
      <SiteContext.Provider value={inPart}>
        <BlockRenderer doc={doc} />
      </SiteContext.Provider>
    </Tag>
  )
}

export default TemplatePartBlock