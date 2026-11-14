import React from "react"
import { normalizeSiteBlockAttrs } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { useSiteRenderContext, type SiteMenu, type SiteMenuLink } from "../utils/siteContext"

/**
 * Navigation (#488): a theme location's menu or one menu by id (decided, design 16.4), as the
 * theme header's `nav.site-nav` (`is-column` for a column). A link with children gets the
 * header's disclosure (`data-nav-group`, which `theme-init.js` opens; hover and focus open it
 * without JavaScript). With `overlay: phone` (the default) the links fold into a menu button
 * at phone width: a `<details>` that needs no script, shown instead of the row there.
 *
 * No menu assigned to the location, a deleted menu, a failed read or no links: nothing
 * (failures fail soft, design 4.3). Nothing outside a template either.
 */
const NavigationBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const site = useSiteRenderContext()
  if (!site) return null
  const attrs = normalizeSiteBlockAttrs("navigation", block.attrs)
  const menu: SiteMenu | null | undefined =
    attrs.menuId !== undefined
      ? site.menusById[String(attrs.menuId)]
      : attrs.location !== undefined
        ? site.menusByLocation[attrs.location as string]
        : null
  if (!menu || menu.items.length === 0) return null
  const label = menu.name || "Menu"
  const column = attrs.layout === "column"
  const folds = attrs.overlay !== "never"
  const subId = (link: SiteMenuLink) => `nav-sub-${block.id}-${link.id}`

  const row = (
    <nav className={column ? "site-nav is-column" : "site-nav"} aria-label={label}>
      {menu.items.map((link) =>
        link.children.length === 0 ? (
          <a key={link.id} href={link.url} aria-current={link.current ? "page" : undefined}>
            {link.label}
          </a>
        ) : (
          <div key={link.id} className="nav-group" data-nav-group="" data-current={link.current || link.children.some((child) => child.current) ? "true" : undefined}>
            <a href={link.url} aria-current={link.current ? "page" : undefined}>
              {link.label}
            </a>
            <button type="button" className="nav-sub-toggle" aria-expanded="false" aria-controls={subId(link)} aria-label={`${link.label}: more links`} data-nav-sub-toggle="">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6"></path>
              </svg>
            </button>
            <ul id={subId(link)} className="nav-submenu" role="list">
              {link.children.map((child) => (
                <li key={child.id}>
                  <a href={child.url} aria-current={child.current ? "page" : undefined}>
                    {child.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )
      )}
    </nav>
  )

  if (!folds) {
    return (
      <div id={anchorId} className="nav-block">
        {row}
      </div>
    )
  }
  return (
    <div id={anchorId} className="nav-block has-overlay">
      {row}
      <details className="nav-overlay">
        <summary className="icon-btn" aria-label={`${label}: open menu`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16"></path>
          </svg>
        </summary>
        <nav className="nav-overlay-panel" aria-label={label}>
          {menu.items.map((link) => (
            <React.Fragment key={link.id}>
              <a href={link.url} aria-current={link.current ? "page" : undefined}>
                {link.label}
              </a>
              {link.children.length > 0 && (
                <ul className="mobile-submenu" role="list">
                  {link.children.map((child) => (
                    <li key={child.id}>
                      <a href={child.url} aria-current={child.current ? "page" : undefined}>
                        {child.label}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </React.Fragment>
          ))}
        </nav>
      </details>
    </div>
  )
}

export default NavigationBlock