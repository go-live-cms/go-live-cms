import React from "react";
import { Link, useLocation } from "react-router-dom";
import { extractSvgPath } from "@gl-admin/components/ui/Icon";
import SidebarItem from "@gl-admin/components/sidebar/SidebarItem";
import SidebarUserProfile from "./SidebarUserProfile";
import GLIcon from "@gl-admin/assets/gl-logo.svg?raw";
import "@gl-admin/assets/styles/components/sidebar/sidebar.scss";

import type { Navigation, Section, IconPath } from "@gl-admin/types/sidebar";

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
      sub: [
        { name: "Pages", link: "/content/pages/" },
        { name: "Posts", link: "/content/posts/" },
      ],
    },
  ],
  [
    { icon: "media" as IconPath, name: "Media", link: "/media/" },
    { icon: "plugins" as IconPath, name: "Plugins", link: "/plugins/" },
  ],
];

const Sidebar: React.FC = () => {
  const location = useLocation();

  const isActiveLink = (section: Section) => {
    return ((location.pathname === section.link && section.link !== "/") || (location.pathname === "/" && section.name === "Dashboard")) && section.type !== "external";
  };

  return (
    <nav className="admin-sidebar">
      <Link to="/" className="admin-sidebar__head">
        <svg width="35" height="35" viewBox="0 0 35 35" className="logo"
          dangerouslySetInnerHTML={{ __html: extractSvgPath(GLIcon) }}
        />
        <h1><b>Go</b>Live</h1>
      </Link>
      <div className="admin-sidebar__nav">
        {navigation.map((section, i) => (
          <React.Fragment key={`sidebar-section-wrapper-${i}`}>
            <div className="admin-sidebar__nav_section" key={`sidebar-section-${i}`}>
              {section.map((item, j) => (
                <React.Fragment key={`sidebar-item-${j}`}>
                  <SidebarItem
                    iconPath={item.icon}
                    name={item.name}
                    link={item.link}
                    type={item?.type}
                    key={item.name}
                    isActive={isActiveLink(item)}
                  />
                  {item.sub &&
                    item.sub.map((subItem) => (
                      <SidebarItem
                        key={subItem.name}
                        name={subItem.name}
                        link={subItem.link}
                        subItem={true}
                        isActive={isActiveLink(subItem)}
                      />
                    ))}
                </React.Fragment>
              ))}
            </div>
            {i !== navigation.length - 1 && <hr className="admin-sidebar__divider" />}
          </React.Fragment>
        ))}
      </div>
      <div
        className="admin-sidebar__bottom"
      >
        <SidebarUserProfile />
      </div>
    </nav>
  );
};

export default Sidebar;