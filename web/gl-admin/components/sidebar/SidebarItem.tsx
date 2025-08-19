import React, { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import SidebarIcon from "./SidebarIcon";
import "@gl-admin/assets/styles/components/sidebar/sidebar-item.scss";


import type { IconPath, IconGradient } from "@gl-admin/types/sidebar";

interface Props {
    iconPath?: IconPath;
    name?: string;
    link?: string;
    subItem?: boolean;
    gradient?: IconGradient;
    type?: "external";
    isActive?: boolean;
}

const SidebarItem: React.FC<Props> = ({
    iconPath = '',
    name = '',
    link = '#',
    subItem = false,
    isActive = false,
    gradient = ["#b3b3b34d", "#00000026"],
    type,
}) => {
    const iconGradient = `background: linear-gradient(182deg, ${gradient[0]} 3.56%, ${gradient[1]} 101.28%); box-shadow: 0 0 5.5px 0 #00000026 inset;`;

    return (
        <>
            {type === "external" ?
                <a href={link} className={`sidebar-item${subItem ? ' sub' : ''}${isActive ? ' active' : ''}`} target="_blank" rel="noopener noreferrer">
                    {iconPath && (
                        <div
                            className="sidebar-item__icon"
                        >
                            <SidebarIcon path={iconPath} />
                        </div>
                    )}
                    <span>{name}</span>
                </a>
                : (
                    <Link
                        className={`sidebar-item${subItem ? ' sub' : ''}${isActive ? ' active' : ''}`}
                        to={link}
                    >
                        {iconPath && (
                            <div
                                className="sidebar-item__icon"
                                style={isActive ? { ...parseStyleString(iconGradient) } : undefined}
                            >
                                <SidebarIcon path={iconPath} />
                            </div>
                        )}
                        <span>{name}</span>
                    </Link>
                )}
        </>
    );
};

function parseStyleString(style: string): React.CSSProperties {
    const styleObj: Record<string, string> = {};
    style.split(';').forEach(rule => {
        const [key, value] = rule.split(':').map(s => s && s.trim());
        if (key && value) {
            const camelKey = key.replace(/-([a-z])/g, g => g[1].toUpperCase());
            styleObj[camelKey] = value;
        }
    });
    return styleObj as React.CSSProperties;
}

export default SidebarItem;