import React, { useState, useRef, useEffect, useCallback } from "react"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import { Link, useLocation } from "react-router-dom"
import { extractSvgPath, Icon } from "@gl-admin/components/ui/Icon"
import SidebarItem from "@gl-admin/components/sidebar/SidebarItem"
import Tooltip from "@gl-admin/components/ui/Tooltip"
import SidebarUserProfile from "./SidebarUserProfile"
import GLIcon from "@gl-admin/assets/gl-logo.svg?raw"
import { getPostTypes } from "@gl-admin/lib/api/postTypes"
import "@gl-admin/assets/styles/components/sidebar/sidebar.scss"

import type { Navigation, Section, IconPath } from "@gl-admin/types/sidebar"
import type { PostType } from "@gl-admin/lib/api/types"

const ORIGINAL_WIDTH = 26 * 16
const MIN_WIDTH = ORIGINAL_WIDTH * 0.8
const MAX_WIDTH = ORIGINAL_WIDTH * 1.2
// Must match the drawer breakpoint in sidebar.scss
const MOBILE_QUERY = "(width <= 768px)"
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Keeps Tab / Shift+Tab cycling inside the open drawer
function trapFocus(e: KeyboardEvent, container: HTMLElement) {
  const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0
  )
  if (items.length === 0) return

  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement

  if (!container.contains(active)) {
    e.preventDefault()
    first.focus()
  } else if (e.shiftKey && active === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

function BrandLink({ className, headingTag: Heading = "h1" }: { className: string; headingTag?: "h1" | "span" }) {
  return (
    <Link to="/" className={className}>
      <svg
        width="35"
        height="35"
        viewBox="0 0 35 35"
        className="logo"
        dangerouslySetInnerHTML={{ __html: extractSvgPath(GLIcon) }}
      />
      <Heading>
        <b>Go</b>Live
      </Heading>
    </Link>
  )
}

// Static sections that don't change
const topSection: Section[] = [
  { icon: "dashboard" as IconPath, name: "Dashboard", link: "/" },
  { icon: "new-tab" as IconPath, name: "View site", link: "/", type: "external" },
]

const bottomSections: Section[][] = [
  [
    { icon: "media" as IconPath, name: "Media", link: "/media/" },
    { icon: "options" as IconPath, name: "Taxonomies", link: "/taxonomies/" },
    { icon: "plugins" as IconPath, name: "Plugins", link: "/plugins/" },
    { icon: "paintbrush" as IconPath, name: "Themes", link: "/themes/" },
  ],
  [
    { icon: "user" as IconPath, name: "Users", link: "/users/" },
    { icon: "settings" as IconPath, name: "Settings", link: "/settings/" }
  ]
];

// Default content section (used before API loads)
const defaultContentSection: Section[] = [
  { icon: "content" as IconPath, name: "All content", link: "/content" },
  { icon: "page" as IconPath, name: "Pages", link: "/content/pages/" },
  { icon: "post" as IconPath, name: "Posts", link: "/content/posts/" },
]

// Map post type names to icons (fallback to "content" icon)
const POST_TYPE_ICONS: Record<string, string> = {
  post: "post",
  page: "page",
}

function buildContentSection(postTypes: PostType[]): Section[] {
  const items: Section[] = [{ icon: "content" as IconPath, name: "All content", link: "/content" }]

  // Sort by menu_position (nulls last), then alphabetical
  const sorted = [...postTypes].sort((a, b) => {
    const posA = a.menu_position ?? 999
    const posB = b.menu_position ?? 999
    if (posA !== posB) return posA - posB
    return a.label.localeCompare(b.label)
  })

  for (const pt of sorted) {
    items.push({
      icon: (POST_TYPE_ICONS[pt.name] || "content") as IconPath,
      name: pt.label,
      link: `/content/${pt.name}/`,
    })
  }

  return items
}

const Sidebar: React.FC = () => {
  const location = useLocation()
  const { isDark } = useGoLive()
  const navIconColor = isDark ? "#FFFFFF" : "#46484A"
  const initialWidth = parseInt(localStorage.getItem("sidebarWidth") || "") || ORIGINAL_WIDTH
  const [sidebarWidth, setSidebarWidth] = useState(`${initialWidth}px`)
  const [isClosed, setIsClosed] = useState(localStorage.getItem("sidebarState") === "true" || false)
  const [contentSection, setContentSection] = useState<Section[]>(defaultContentSection)
  // Off-canvas drawer state, only used below the mobile breakpoint (sidebar.scss)
  const [isMobileOpen, setIsMobileOpen] = useState(false)
  const resizing = useRef(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const navRef = useRef<HTMLElement>(null)

  // Fetch post types to build dynamic content section
  useEffect(() => {
    getPostTypes()
      .then(({ data }) => {
        if (data && data.length > 0) {
          setContentSection(buildContentSection(data))
        }
      })
      .catch((err) => {
        console.warn("Failed to fetch post types for sidebar:", err)
      })
  }, [])

  const navigation: Navigation = [topSection, contentSection, ...bottomSections]

  useEffect(() => {
    localStorage.setItem("sidebarWidth", sidebarWidth)
  }, [sidebarWidth])

  useEffect(() => {
    localStorage.setItem("sidebarState", isClosed.toString())
  }, [isClosed])

  const closeMobileMenu = useCallback(() => {
    setIsMobileOpen(false)
    menuButtonRef.current?.focus()
  }, [])

  // Close the drawer after back/forward navigation
  useEffect(() => {
    setIsMobileOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!isMobileOpen) return

    closeButtonRef.current?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      const nav = navRef.current
      if (!nav) return
      // While the user menu is open, Escape closes that instead (SidebarUserProfile)
      if (e.key === "Escape" && !nav.querySelector(".sidebar-popup.open")) closeMobileMenu()
      if (e.key === "Tab") trapFocus(e, nav)
    }
    // The drawer only exists below the breakpoint; drop it if the viewport grows
    const mobileQuery = window.matchMedia(MOBILE_QUERY)
    const onQueryChange = () => {
      if (!mobileQuery.matches) setIsMobileOpen(false)
    }

    window.addEventListener("keydown", onKeyDown)
    mobileQuery.addEventListener("change", onQueryChange)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      mobileQuery.removeEventListener("change", onQueryChange)
    }
  }, [isMobileOpen, closeMobileMenu])

  // Links to the current page don't change location, so close on any link click
  const handleNavClick = (e: React.MouseEvent) => {
    if (isMobileOpen && (e.target as Element).closest("a")) closeMobileMenu()
  }

  const handleResizeStart = (e: React.MouseEvent) => {
    resizing.current = true
    document.body.style.cursor = "ew-resize"

    const startX = e.clientX
    const startWidth = parseInt(sidebarWidth)

    let animationFrameId: number | null = null

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!resizing.current) return

      if (animationFrameId) return

      animationFrameId = window.requestAnimationFrame(() => {
        let newWidth = startWidth + (moveEvent.clientX - startX)
        newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth))
        setSidebarWidth(`${newWidth}px`)
        animationFrameId = null
      })
    }

    const onMouseUp = () => {
      resizing.current = false
      document.body.style.cursor = ""
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
      if (animationFrameId) {
        window.cancelAnimationFrame(animationFrameId)
        animationFrameId = null
      }
    }

    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
  }

  const isActiveLink = (section: Section) => {
    return (
      ((location.pathname === section.link && section.link !== "/") ||
        (location.pathname === "/" && section.name === "Dashboard")) &&
      section.type !== "external"
    )
  }

  return (
    <>
    <header className="admin-mobile-bar">
      <button
        type="button"
        ref={menuButtonRef}
        className="admin-mobile-bar__toggle"
        aria-label="Open menu"
        aria-controls="admin-sidebar"
        aria-expanded={isMobileOpen}
        onClick={() => setIsMobileOpen(true)}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      <BrandLink className="admin-mobile-bar__logo" headingTag="span" />
    </header>
    <div
      className={`admin-sidebar-backdrop${isMobileOpen ? " open" : ""}`}
      onClick={closeMobileMenu}
      aria-hidden="true"
    />
    <nav
      id="admin-sidebar"
      ref={navRef}
      className={`admin-sidebar${isClosed ? " closed" : ""}${isMobileOpen ? " mobile-open" : ""}`}
      style={{ width: sidebarWidth }}
      role={isMobileOpen ? "dialog" : undefined}
      aria-modal={isMobileOpen || undefined}
      aria-label="Admin navigation"
      onClick={handleNavClick}
    >
      <button
        type="button"
        ref={closeButtonRef}
        className="admin-sidebar__close"
        aria-label="Close menu"
        onClick={closeMobileMenu}
      >
        <Icon name="close" color={navIconColor} width="20px" height="20px" />
      </button>
      <BrandLink className="admin-sidebar__head" />
      <div className="admin-sidebar__nav">
        {navigation.map((section, i) => (
          <React.Fragment key={`sidebar-section-wrapper-${i}`}>
            <div className="admin-sidebar__nav_section" key={`sidebar-section-${i}`}>
              {section.map((item, j) => (
                <Tooltip content={item.name} key={`sidebar-item-${j}`} enabled={isClosed && !isMobileOpen}>
                  <SidebarItem
                    iconPath={item.icon}
                    name={item.name}
                    link={item.link}
                    type={item?.type}
                    key={item.name}
                    isActive={isActiveLink(item)}
                  />
                </Tooltip>
              ))}
            </div>
            {i !== navigation.length - 1 && <hr className="admin-sidebar__divider" />}
          </React.Fragment>
        ))}
      </div>
      <div className="admin-sidebar__bottom">
        <SidebarUserProfile />
      </div>
      <div className="admin-sidebar__controller" onClick={() => setIsClosed(!isClosed)}>
        <Icon name="next" color={navIconColor} height="16px" mirror_horizontally={!isClosed} />
      </div>
      <div className="admin-sidebar__resize-handle" onMouseDown={handleResizeStart}></div>
    </nav>
    </>
  )
}

export default Sidebar
