import React from "react";
import { useLocation } from "react-router-dom";
import SidebarItem from "@gl-admin/components/sidebar/SidebarItem";
import Profile from "@gl-admin/components/sidebar/Profile";
import Icon from "@gl-admin/components/ui/Icon";
import "@gl-admin/assets/styles/components/sidebar/sidebar.scss";

import type { Navigation, Section, IconPath } from "@gl-admin/types/sidebar";

const navigation: Navigation = [
  [
    { icon: "dashboard" as IconPath, name: "Dashboard", link: "/", gradient: ["#688BFF", "#00FBFB"] },
    { icon: "new-tab" as IconPath, name: "View site", link: "/", type: "external" },
  ],
  [
    {
      icon: "content" as IconPath,
      name: "All content",
      link: "/content",
      gradient: ["#F9C700", "#00FBFB"],
      sub: [
        { name: "Pages", link: "/content/pages/" },
        { name: "Posts", link: "/content/posts/" },
      ],
    },
  ],
  [
    { icon: "media" as IconPath, name: "Media", link: "/media/", gradient: ["#FFB62D", "#FF1A5B"] },
    { icon: "plugins" as IconPath, name: "Plugins", link: "/plugins/", gradient: ["#51FB9E", "#34BD0A"] },
  ],
];

const Sidebar: React.FC = () => {
  const location = useLocation();

  const isActiveLink = (section: Section) => {
    return (location.pathname === section.link || (location.pathname.startsWith(section.link) && section.link !== "/")) && section.type !== "external";
  };

  return (
    <nav className="admin-sidebar">
      <div className="admin-sidebar__head">
        <Icon name="logoIcon" className="logo" width="42px" height="42px" />
      </div>
      <div className="admin-sidebar__nav">
        {navigation.map((section, i) => (
          <div className="admin-sidebar__nav_section" key={i}>
            {section.map((item, j) => (
              <React.Fragment key={item.name}>
                <SidebarItem
                  iconPath={item.icon}
                  name={item.name}
                  link={item.link}
                  gradient={item.gradient}
                  type={item?.type}
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
        ))}
      </div>
      <div className="admin-sidebar__bottom">
        <Profile />
      </div>
    </nav>
  );
};

export default Sidebar;