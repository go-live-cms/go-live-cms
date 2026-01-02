import React, { useState, useRef, useEffect } from "react"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import { Link, useLocation } from "react-router-dom"
import { extractSvgPath, Icon } from "@gl-admin/components/ui/Icon"
import SidebarItem from "@gl-admin/components/sidebar/SidebarItem"
import Tooltip from "@gl-admin/components/ui/Tooltip"
import SidebarUserProfile from "./SidebarUserProfile"
import GLIcon from "@gl-admin/assets/gl-logo.svg?raw"
import "@gl-admin/assets/styles/components/sidebar/sidebar.scss"

import type { Navigation, Section, IconPath } from "@gl-admin/types/sidebar"

const ORIGINAL_WIDTH = 26 * 16
const MIN_WIDTH = ORIGINAL_WIDTH * 0.8
const MAX_WIDTH = ORIGINAL_WIDTH * 1.2

const navigation: Navigation = [
  [
    { icon: "dashboard" as IconPath, name: "Dashboard", link: "/" },
    { icon: "new-tab" as IconPath, name: "View site", link: "/", type: "external" },
  ],
  [
    {
      icon: "content" as IconPath,
      name: "All content",
      link: "/content",
    },
    {
      icon: "page" as IconPath,
      name: "Pages",
      link: "/content/pages/",
    },
    {
      icon: "post" as IconPath,
      name: "Posts",
      link: "/content/posts/",
    },
  ],
  [
    { icon: "media" as IconPath, name: "Media", link: "/media/" },
    { icon: "plugins" as IconPath, name: "Plugins", link: "/plugins/" },
  ],
  [{ icon: "settings" as IconPath, name: "Settings", link: "/settings/" }],
]

const Sidebar: React.FC = () => {
  const location = useLocation()
  const { isDark } = useGoLive()
  const navIconColor = isDark ? "#FFFFFF" : "#46484A"
  const initialWidth = parseInt(localStorage.getItem("sidebarWidth") || "") || ORIGINAL_WIDTH
  const [sidebarWidth, setSidebarWidth] = useState(`${initialWidth}px`)
  const [isClosed, setIsClosed] = useState(localStorage.getItem("sidebarState") === "true" || false)
  const resizing = useRef(false)

  useEffect(() => {
    localStorage.setItem("sidebarWidth", sidebarWidth)
  }, [sidebarWidth])

  useEffect(() => {
    localStorage.setItem("sidebarState", isClosed.toString())
  }, [isClosed])

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
    <nav className={`admin-sidebar${isClosed ? "closed" : ""}`} style={{ width: sidebarWidth }}>
      <Link to="/" className="admin-sidebar__head">
        <svg
          width="35"
          height="35"
          viewBox="0 0 35 35"
          className="logo"
          dangerouslySetInnerHTML={{ __html: extractSvgPath(GLIcon) }}
        />
        <h1>
          <b>Go</b>Live
        </h1>
      </Link>
      <div className="admin-sidebar__nav">
        {navigation.map((section, i) => (
          <React.Fragment key={`sidebar-section-wrapper-${i}`}>
            <div className="admin-sidebar__nav_section" key={`sidebar-section-${i}`}>
              {section.map((item, j) => (
                <Tooltip content={item.name} key={`sidebar-item-${j}`} enabled={isClosed}>
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
  )
}

export default Sidebar
