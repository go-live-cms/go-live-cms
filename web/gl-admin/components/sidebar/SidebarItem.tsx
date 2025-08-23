import React from "react";
import { Link } from "react-router-dom";
import Icon from "@gl-admin/components/ui/Icon";
import "@gl-admin/assets/styles/components/sidebar/sidebar-item.scss";


import type { IconPath, IconGradient } from "@gl-admin/types/sidebar";

interface Props {
    iconPath?: IconPath;
    name?: string;
    link?: string | null;
    subItem?: boolean;
    type?: "external";
    isActive?: boolean;
    onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}

const SidebarItem: React.FC<Props> = ({
    iconPath = '',
    name = '',
    link = '#',
    subItem = false,
    isActive = false,
    type,
    onClick,
}) => {

    if (link) {
        return <>
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
                )
            }
        </>
    } else {
        return (
            <div
                className={`sidebar-item${subItem ? ' sub' : ''}${isActive ? ' active' : ''}`}
                onClick={onClick}
            >
                {iconPath && (
                    <div
                        className="sidebar-item__icon"
                    >
                        <Icon name={iconPath} color="#46484A" />
                    </div>
                )}
                <span className="sidebar-item__name">{name}</span>
            </div>
        );
    }
}

export default SidebarItem;