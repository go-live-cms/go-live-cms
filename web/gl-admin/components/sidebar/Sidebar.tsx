import { useEffect, useId, useMemo, useState, type MouseEvent } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { extractSvgPath } from "@gl-admin/components/ui/Icon"
import { IconButton } from "@gl-admin/components/ui/Button"
import Drawer from "@gl-admin/components/ui/Drawer"
import Avatar from "@gl-admin/components/ui/Avatar"
import Menu, { MenuItem, MenuSeparator } from "@gl-admin/components/ui/Menu"
import { ChevronRightIcon, MenuIcon, MoreIcon, PlusIcon } from "@gl-admin/components/ui/icons"
import GLIcon from "@gl-admin/assets/gl-logo.svg?raw"
import { POST_TYPES_CHANGED, getPostTypes } from "@gl-admin/lib/api/postTypes"
import { getTaxonomyTypes } from "@gl-admin/lib/api/taxonomies"
import type { PostType, TaxonomyType } from "@gl-admin/lib/api/types"
import { authManager } from "@gl-admin/lib/auth"
import { useAuthUser } from "@gl-admin/lib/hooks/useAuthUser"
import { useCurrentRole } from "@gl-admin/lib/hooks/useCurrentRole"
import { useMediaQuery } from "@gl-admin/lib/hooks/useMediaQuery"
import { canCreateContent, isContentModerator, roleLabel } from "@gl-admin/lib/roles"
import { activeKey, buildNavigation, parentOf, type NavItem, type NavSection } from "./nav"
import NavIcon from "./NavIcon"
import "@gl-admin/assets/styles/components/sidebar/sidebar.scss"

// The app shell's navigation (#339): a fixed sidebar on desktop; at phone width a top
// bar whose menu button opens the same sidebar as an off-canvas drawer (Drawer: focus
// trapped inside, Escape or the scrim closes it, focus goes back to the button).

// Must match the breakpoint in sidebar.scss.
export const MOBILE_QUERY = "(width <= 768px)"

// The logo's gradient and clip-path ids, made unique per copy: the phone bar, the
// sidebar and the gallery can show it more than once, and a url(#id) that resolves to
// a copy inside a display:none parent paints nothing.
function logoMarkup(suffix: string): string {
  return extractSvgPath(GLIcon)
    .replace(/id="([^"]+)"/g, `id="$1-${suffix}"`)
    .replace(/url\(#([^)]+)\)/g, `url(#$1-${suffix})`)
}

function Brand() {
  const suffix = useId().replace(/[^a-zA-Z0-9_-]/g, "")
  const markup = useMemo(() => logoMarkup(suffix), [suffix])
  return (
    <Link to="/" className="gl-sidebar__brand">
      <svg
        width="28"
        height="28"
        viewBox="0 0 35 35"
        className="gl-sidebar__logo"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: markup }}
      />
      <span className="gl-sidebar__brand-name">
        <b>Go</b>Live
      </span>
    </Link>
  )
}

function NavLink({ item, current, nested = false }: { item: NavItem; current: string | null; nested?: boolean }) {
  const isCurrent = item.key === current
  return (
    <Link
      to={item.to}
      className={`gl-sidebar__link${nested ? " gl-sidebar__link--nested" : ""}${isCurrent ? " is-current" : ""}`}
      aria-current={isCurrent ? "page" : undefined}
    >
      {!nested && <NavIcon name={item.icon} />}
      <span className="gl-sidebar__label">{item.label}</span>
    </Link>
  )
}

function NavGroup({ item, current }: { item: NavItem; current: string | null }) {
  const [open, setOpen] = useState(true)
  const id = `gl-nav-${item.key}`
  const inside = item.children!.some((c) => c.key === current)

  return (
    <>
      <div className={`gl-sidebar__group${inside ? " is-inside" : ""}`}>
        <Link to={item.to} className="gl-sidebar__link gl-sidebar__link--group">
          <NavIcon name={item.icon} />
          <span className="gl-sidebar__label">{item.label}</span>
        </Link>
        <button
          type="button"
          className="gl-sidebar__toggle"
          aria-expanded={open}
          aria-controls={id}
          aria-label={`${item.label} sections`}
          onClick={() => setOpen(!open)}
        >
          <ChevronRightIcon size={14} className="gl-sidebar__chevron" />
        </button>
      </div>
      {open && (
        <div id={id} className="gl-sidebar__children">
          {item.children!.map((child) => (
            <NavLink key={child.key} item={child} current={current} nested />
          ))}
        </div>
      )}
    </>
  )
}

function UserMenu() {
  const user = useAuthUser()
  const navigate = useNavigate()
  if (!user) return null
  const role = roleLabel(user.role)
  const name = user.full_name || user.username

  return (
    <Menu
      label="Account"
      placement="top-start"
      className="gl-sidebar__user-menu"
      trigger={(props) => (
        <button {...props} type="button" className="gl-sidebar__user" aria-label={`Account: ${name}, ${role}`}>
          <Avatar user={{ id: user.id, name }} size={28} decorative />
          <span className="gl-sidebar__user-text">
            <span className="gl-sidebar__user-name">{name}</span>
            <span className="gl-sidebar__user-role">{role}</span>
          </span>
          <MoreIcon className="gl-sidebar__user-more" />
        </button>
      )}
    >
      <MenuItem onSelect={() => navigate("/profile")}>My profile</MenuItem>
      <MenuItem onSelect={() => window.open("/", "_blank", "noopener,noreferrer")}>View site</MenuItem>
      <MenuSeparator />
      {/* AuthGuard sends the signed-out user to the login page. */}
      <MenuItem onSelect={() => void authManager.logout()}>Log out</MenuItem>
    </Menu>
  )
}

type SidebarNavProps = {
  sections: NavSection[]
  current: string | null
}

// The sidebar's content, shared by the desktop column and the phone drawer.
export function SidebarNav({ sections, current }: SidebarNavProps) {
  return (
    <div className="gl-sidebar">
      <Brand />
      <nav className="gl-sidebar__nav" aria-label="Admin">
        {sections.map((section) => (
          <div key={section.key} className="gl-sidebar__section">
            {section.label && <span className="gl-sidebar__heading">{section.label}</span>}
            {section.items.map((item) =>
              item.children ? (
                <NavGroup key={item.key} item={item} current={current} />
              ) : (
                <NavLink key={item.key} item={item} current={current} />
              )
            )}
          </div>
        ))}
      </nav>
      <div className="gl-sidebar__footer">
        <UserMenu />
      </div>
    </div>
  )
}

export default function Sidebar() {
  const location = useLocation()
  const role = useCurrentRole()
  const isMobile = useMediaQuery(MOBILE_QUERY)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [postTypes, setPostTypes] = useState<PostType[] | undefined>()
  const [taxonomyTypes, setTaxonomyTypes] = useState<TaxonomyType[]>([])
  const canManageTerms = isContentModerator(role)

  useEffect(() => {
    const load = () =>
      getPostTypes()
        .then(({ data }) => data.length > 0 && setPostTypes(data))
        .catch((err) => console.warn("Failed to fetch post types for the sidebar:", err))
    load()
    // The Post types screen saved one: its label or menu position may have changed.
    window.addEventListener(POST_TYPES_CHANGED, load)
    return () => window.removeEventListener(POST_TYPES_CHANGED, load)
  }, [])

  useEffect(() => {
    if (!canManageTerms) return
    getTaxonomyTypes()
      .then(({ data }) => setTaxonomyTypes(data))
      .catch((err) => console.warn("Failed to fetch taxonomy types for the sidebar:", err))
  }, [canManageTerms])

  const sections = useMemo(() => buildNavigation({ role, postTypes, taxonomyTypes }), [role, postTypes, taxonomyTypes])
  const current = activeKey(sections, location.pathname, location.search)
  const currentItem = parentOf(sections, current)
  const title = (currentItem?.children?.find((c) => c.key === current) ?? currentItem)?.label

  // Any navigation closes the drawer: a link click, back/forward, the profile item.
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname, location.search])

  // The drawer only exists at phone width; drop it if the viewport grows.
  useEffect(() => {
    if (!isMobile) setDrawerOpen(false)
  }, [isMobile])

  // A click on the link to the page you're on doesn't change location; close anyway.
  // Not for a modified click (new tab or window): the page stays.
  const onDrawerClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if ((e.target as Element).closest("a[href]")) setDrawerOpen(false)
  }

  const nav = <SidebarNav sections={sections} current={current} />

  return (
    <>
      <header className="gl-mobile-bar">
        <IconButton
          className="gl-mobile-bar__toggle"
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          aria-controls={drawerOpen ? "gl-nav-drawer" : undefined}
          icon={<MenuIcon size={20} />}
          onClick={() => setDrawerOpen(true)}
        />
        {title ? <span className="gl-mobile-bar__title">{title}</span> : <span className="gl-mobile-bar__title"><Brand /></span>}
        {canCreateContent(role) && (
          <Link to="/content/post/new" className="gl-mobile-bar__new" aria-label="New post">
            <PlusIcon size={20} className="gl-mobile-bar__new-icon" />
          </Link>
        )}
      </header>
      {!isMobile && <aside className="gl-shell__sidebar">{nav}</aside>}
      {isMobile && (
        <Drawer
          id="gl-nav-drawer"
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          title="Menu"
          closeLabel="Close menu"
          side="left"
          width={300}
          bare
          className="gl-nav-drawer"
        >
          <div className="gl-nav-drawer__body" onClick={onDrawerClick}>
            {nav}
          </div>
        </Drawer>
      )}
    </>
  )
}
