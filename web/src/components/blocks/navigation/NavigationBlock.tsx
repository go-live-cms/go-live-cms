import React from "react"
import { normalizeSiteBlockAttrs } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { footerColumns } from "../../../lib/menuColumns"
import { isHomePath, useSiteRenderContext, type SiteMenu, type SiteMenuLink, type SiteRenderContext } from "../utils/siteContext"
import { SearchFormMarkup, ThemeChoices } from "../utils/themeMarkup"

/**
 * Navigation (#488): a theme location's menu or one menu by id (decided, design 16.4), as the
 * theme header's `nav.site-nav` (`is-column` for a column). A link with children gets the
 * header's disclosure (`data-nav-group`, which `theme-init.js` opens; hover and focus open it
 * without JavaScript). With `overlay: phone` (the default) the links fold into a menu button
 * at phone width: a `<details>` that needs no script, shown instead of the row there.
 *
 * #498, the default theme's own two navigations, so its header and footer parts render what its
 * `SiteHeader` and `SiteFooter` did:
 *
 * - `overlay: menu`: after the row, the header's menu button and phone menu (`dialog.mobile-menu`:
 *   the site's title, Home and the links with their children, a search field, the Light/Dark/System
 *   switch). The theme's script opens and closes it (`data-site-menu-open`, like the switch, no
 *   inline script); its ids are the theme's (`site-menu`, `menu-q`), so one per page. It renders
 *   with no menu too (Home, search and the switch), as the theme's header does.
 * - `layout: columns`: the footer's link columns (`menuColumns.ts`): a column per top-level link
 *   with children, headed by it, and the "Site" column with the other links and the RSS feed,
 *   which is there when the location has no menu too (a deleted menu chosen by id renders nothing).
 *
 * Otherwise no menu assigned to the location, a deleted menu, a failed read or no links: nothing
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
  const items = menu?.items ?? []
  // A menu chosen by id that was deleted renders nothing, in every layout (design 4.1).
  if (attrs.menuId !== undefined && !menu) return null
  if (attrs.layout === "columns") return <FooterColumns anchorId={anchorId} items={items} />
  const label = menu?.name || "Menu"
  const subId = (link: SiteMenuLink) => `nav-sub-${block.id}-${link.id}`
  const row = items.length > 0 && (
    <nav className={attrs.layout === "column" ? "site-nav is-column" : "site-nav"} aria-label={label}>
      {items.map((link) =>
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
        ),
      )}
    </nav>
  )

  if (attrs.overlay === "menu") {
    return (
      <div id={anchorId} className="nav-block has-menu">
        {row}
        <PhoneMenu site={site} items={items} label={label} />
      </div>
    )
  }
  if (items.length === 0) return null
  if (attrs.overlay === "never") {
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
          <MobileLinks items={items} />
        </nav>
      </details>
    </div>
  )
}

/** The phone menu's links: each top-level link, its children under it. */
function MobileLinks({ items }: { items: SiteMenuLink[] }) {
  return (
    <>
      {items.map((link) => (
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
    </>
  )
}

/** #498: the default theme header's menu button and phone menu (`SiteHeader`'s `dialog#site-menu`). */
function PhoneMenu({ site, items, label }: { site: SiteRenderContext; items: SiteMenuLink[]; label: string }) {
  const home = isHomePath(site.currentPath) ? "page" : undefined
  return (
    <>
      <button type="button" className="icon-btn menu-btn" aria-label="Open menu" aria-expanded="false" aria-controls="site-menu" data-site-menu-open="">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16"></path>
        </svg>
      </button>
      <dialog id="site-menu" className="mobile-menu" aria-label="Menu" data-site-menu="">
        <div className="container site-header-inner mobile-menu-bar">
          <a href="/" className="site-title">
            {site.site.title}
          </a>
          <button type="button" className="icon-btn" aria-label="Close menu" data-site-menu-close="">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12"></path>
            </svg>
          </button>
        </div>
        <nav aria-label={label}>
          <a href="/" aria-current={home}>
            Home
          </a>
          <MobileLinks items={items} />
        </nav>
        <div className="mobile-menu-section">
          <SearchFormMarkup id="menu-q" label="Search the blog" compact />
          <fieldset className="appearance">
            <legend className="section-title">Appearance</legend>
            <ThemeChoices variant="segmented" />
          </fieldset>
        </div>
      </dialog>
    </>
  )
}

/** #498: the default theme footer's link columns (`SiteFooter`'s), the "Site" column always there with the RSS feed. */
function FooterColumns({ anchorId, items }: { anchorId?: string; items: SiteMenuLink[] }) {
  const columns = footerColumns(items)
  if (!columns.some((column) => column.heading === null)) columns.push({ heading: null, links: [] })
  return (
    <div id={anchorId} className="nav-block is-columns">
      {columns.map((column, i) =>
        column.heading ? (
          <nav key={column.heading.id} className="footer-col" aria-labelledby={`footer-col-${i}`}>
            <h2 id={`footer-col-${i}`}>
              <a href={column.heading.url} className="footer-heading">
                {column.heading.label}
              </a>
            </h2>
            {column.links.map((link) => (
              <a key={link.id} href={link.url}>
                {link.label}
              </a>
            ))}
          </nav>
        ) : (
          <nav key="site" className="footer-col" aria-labelledby="footer-site">
            <h2 id="footer-site">Site</h2>
            {column.links.map((link) => (
              <a key={link.id} href={link.url}>
                {link.label}
              </a>
            ))}
            <a href="/rss.xml">RSS feed</a>
          </nav>
        ),
      )}
    </div>
  )
}

export default NavigationBlock
