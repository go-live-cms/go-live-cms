import React, { useId } from "react"
import { normalizeSiteBlockAttrs, SEARCH_DEFAULTS } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { useSiteRenderContext } from "../utils/siteContext"
import { SEARCH_PATH } from "../../../lib/searchPath"
import { SearchFormMarkup, SearchIcon } from "../utils/themeMarkup"

/**
 * Search (#488): the theme's `SearchForm` markup, a plain GET to /search, so it works without
 * JavaScript. The label is for screen readers only; the placeholder ("Search the blog" unless set,
 * #498) and the button are the block's. On the search page the field holds the search (#498), as
 * the theme's results page does. With `variant: icon` (#498) it is the theme header's search link
 * instead: an icon to the search page, named by the label. Nothing outside a template.
 */
const SearchBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const site = useSiteRenderContext()
  // Unique on the page even when a part holding this block renders twice.
  const fieldId = `search-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`
  if (!site) return null
  const attrs = normalizeSiteBlockAttrs("search", block.attrs) as { label?: string; placeholder?: string; button?: string; variant?: "icon" }
  const label = attrs.label ?? SEARCH_DEFAULTS.label
  if (attrs.variant === "icon") {
    return (
      <a id={anchorId} href={SEARCH_PATH} className="icon-btn" aria-label={label}>
        <SearchIcon />
      </a>
    )
  }
  return (
    <SearchFormMarkup
      anchorId={anchorId}
      className="search-block"
      id={fieldId}
      label={label}
      value={site.route?.kind === "search" ? (site.route.search?.query ?? "") : ""}
      {...(attrs.placeholder ? { placeholder: attrs.placeholder } : {})}
      button={attrs.button ?? SEARCH_DEFAULTS.button}
    />
  )
}

export default SearchBlock
