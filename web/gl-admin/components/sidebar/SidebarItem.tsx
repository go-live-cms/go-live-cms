import React from "react";
import { Link } from "react-router-dom";
import Icon from "@gl-admin/components/ui/Icon";
import "@gl-admin/assets/styles/components/sidebar/sidebar-item.scss";


import type { IconPath, IconGradient } from "@gl-admin/types/sidebar";

interface Props {
    iconPath?: IconPath;
    name?: string;
    link?: string;
    subItem?: boolean;
    type?: "external";
    isActive?: boolean;
}

const SidebarItem: React.FC<Props> = ({
    iconPath = '',
    name = '',
    link = '#',
    subItem = false,
    isActive = false,
    type,
}) => (
    <>
        {type === "external" ?
            <a href={link} className={`sidebar-item${subItem ? ' sub' : ''}${isActive ? ' active' : ''}`} target="_blank" rel="noopener noreferrer">
                {iconPath && (
                    <div
                        className="sidebar-item__icon"
                    >
                        <Icon name={iconPath} color="#46484A" />
                    </div>
                )}
                <span className="sidebar-item__name">{name}</span>
            </a>
            : (
                <Link
                    className={`sidebar-item${subItem ? ' sub' : ''}${isActive ? ' active' : ''}`}
                    to={link}
                >
                    {iconPath && (
                        <div
                            className="sidebar-item__icon"
                        >
                            <Icon name={iconPath} color="#46484A" />
                        </div>
                    )}
                    <span className="sidebar-item__name">{name}</span>
                </Link>
            )}
    </>
);

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