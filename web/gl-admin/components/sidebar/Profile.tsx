import { useState } from "react";
import { useSelect } from "@gl-admin/utils/select";
import { api } from "@gl-admin/lib/api";
import { authManager } from "@gl-admin/lib/auth";
import { formatUserName } from "@gl-admin/utils/formatting";
import Icon from "@gl-admin/components/ui/Icon";
import ProfileIcon from "./ProfileIcon";
import "@gl-admin/assets/styles/components/sidebar/profile.scss";

export default function Profile() {
    const [hovered, setHovered] = useState(false);
    const {
        open,
        setOpen,
        optionsStyle,
        ref,
        handleSelectClick,
    } = useSelect()
    const auth = authManager.getState();
    const user = auth.user;

    if (!user) return null;

    async function handleLogout() {
        authManager.logout();
        await api.logout({ refresh_token: auth.refreshToken });
        setOpen(false);
        window.location.href = "/login";
    }

    return (
        <div
            className={`user ${open ? "open" : ""}`}
            ref={ref}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={handleSelectClick}
        >
            <div className="user__profile">
                <ProfileIcon fullName={user.full_name} hovered={hovered} />
            </div>
            <div className="user__name">
                {formatUserName(user.full_name)}
            </div>
            <Icon name="dropdown" mirror_vertically={open} color="#333536" width="7px" height="4.3px" />

            <div className="user__options" style={optionsStyle}>
                <div onClick={handleLogout}>
                    <Icon name="logout" color="#333536" />
                    <span>Logout</span>
                </div>
            </div>
        </div>
    );
}