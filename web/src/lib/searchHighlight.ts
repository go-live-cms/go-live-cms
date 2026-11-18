/**
 * Search highlights made safe for raw HTML (#145), with no imports: the search page's code layout and,
 * since #498, the search results site block (which the admin's preview loads too) both check them.
 */

/**
 * The API's highlight HTML, made safe for set:html whatever it holds: the only tags
 * kept are <mark> and </mark>, every other < and > is escaped, and so is any & that
 * doesn't start an entity. The API already sends exactly that; this keeps one bug
 * there from becoming markup on the page.
 */
export function safeHighlight(html: string | null | undefined): string {
  if (!html) return ""
  let open = false
  const parts = html.split(/(<\/?mark>)/)
  const out = parts.map((part) => {
    if (part === "<mark>") {
      if (open) return ""
      open = true
      return part
    }
    if (part === "</mark>") {
      if (!open) return ""
      open = false
      return part
    }
    return part
      .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});)/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  })
  return out.join("") + (open ? "</mark>" : "")
}
