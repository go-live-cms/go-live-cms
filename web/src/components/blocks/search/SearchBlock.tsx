import React from "react"
import { normalizeSiteBlockAttrs, SEARCH_DEFAULTS } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { useSiteRenderContext } from "../utils/siteContext"
import { MAX_QUERY_LENGTH, SEARCH_PATH } from "../../../lib/searchPath"

/**
 * Search (#488): the theme's `SearchForm` markup, a plain GET to /search, so it works
 * without JavaScript. The label is for screen readers only; the placeholder and the button
 * are the block's. Nothing outside a template.
 */
const SearchBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const site = useSiteRenderContext()
  if (!site) return null
  const attrs = normalizeSiteBlockAttrs("search", block.attrs) as { label?: string; placeholder?: string; button?: string }
  const fieldId = `search-${block.id}`
  return (
    <form id={anchorId} role="search" className="search-form search-block" action={SEARCH_PATH} method="get">
      <label htmlFor={fieldId} className="sr-only">
        {attrs.label ?? SEARCH_DEFAULTS.label}
      </label>
      <input
        id={fieldId}
        type="search"
        name="q"
        className="input"
        placeholder={attrs.placeholder}
        maxLength={MAX_QUERY_LENGTH}
        autoComplete="off"
        enterKeyHint="search"
      />
      <button type="submit" className="btn btn-primary">
        {attrs.button ?? SEARCH_DEFAULTS.button}
      </button>
    </form>
  )
}

export default SearchBlock