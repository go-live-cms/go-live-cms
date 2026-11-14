import React from "react"
import { normalizeSiteBlockAttrs } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { isHomePath, useSiteRenderContext } from "../utils/siteContext"

/**
 * Site title (#488, the blocks canvas's "Published site blocks"): the site's name from
 * Settings › General, as a paragraph (`p > a.site-title`, the theme header's link) or an
 * H1 / H2 (`h1.title`), linking home unless set not to. Nothing outside a template.
 */
const SiteTitleBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const site = useSiteRenderContext()
  if (!site || !site.site.title) return null
  const attrs = normalizeSiteBlockAttrs("site_title", block.attrs)
  const current = isHomePath(site.currentPath) ? "page" : undefined
  const name = attrs.link === false ? site.site.title : (
    <a href="/" className={attrs.level ? undefined : "site-title"} aria-current={current}>
      {site.site.title}
    </a>
  )
  if (attrs.level === 1) return <h1 id={anchorId} className="title site-title-block">{name}</h1>
  if (attrs.level === 2) return <h2 id={anchorId} className="title site-title-block">{name}</h2>
  return (
    <p id={anchorId} className="site-title-block">
      {attrs.link === false ? <span className="site-title">{name}</span> : name}
    </p>
  )
}

export default SiteTitleBlock