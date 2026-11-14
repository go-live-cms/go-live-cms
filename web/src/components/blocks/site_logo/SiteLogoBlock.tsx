import React from "react"
import { normalizeSiteBlockAttrs, SITE_LOGO_DEFAULT_WIDTH } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { responsiveImageAttrs } from "../utils/responsiveImage"
import { isHomePath, useSiteRenderContext } from "../utils/siteContext"

/**
 * Site logo (#488): the image chosen in Settings › General (`site_logo_media_id`) at the
 * block's width, `a.site-logo-block > img.site-logo` linking home (named "<site>, home"), or a
 * `span.site-logo-block` whose image is named after the site. No logo, a deleted one or a URL
 * that isn't an upload: nothing. Nothing outside a template either.
 */
const SiteLogoBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const site = useSiteRenderContext()
  const logo = site?.logo
  if (!site || !logo) return null
  const attrs = normalizeSiteBlockAttrs("site_logo", block.attrs)
  const width = (attrs.width as number | undefined) ?? SITE_LOGO_DEFAULT_WIDTH
  const image = responsiveImageAttrs(logo.media.media_path, logo.media, `${width}px`)
  if (!image.src) return null
  const height = image.width && image.height ? Math.max(1, Math.round((width * image.height) / image.width)) : undefined
  const name = site.site.title || logo.alt
  const img = (
    <img
      className="site-logo"
      src={image.src}
      srcSet={image.srcSet}
      sizes={image.srcSet ? image.sizes : undefined}
      width={width}
      height={height}
      // Linked, the link carries the name; on its own, the image does.
      alt={attrs.link === false ? name : ""}
      decoding="async"
    />
  )
  if (attrs.link === false) {
    return (
      <span id={anchorId} className="site-logo-block">
        {img}
      </span>
    )
  }
  return (
    <a id={anchorId} href="/" className="site-logo-block" aria-label={name ? `${name}, home` : "Home"} aria-current={isHomePath(site.currentPath) ? "page" : undefined}>
      {img}
    </a>
  )
}

export default SiteLogoBlock