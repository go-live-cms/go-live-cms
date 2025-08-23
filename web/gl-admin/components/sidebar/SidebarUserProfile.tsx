import { useSelect } from "@gl-admin/utils/select";
import { api } from "@gl-admin/lib/api";
import { authManager } from "@gl-admin/lib/auth";
import UserProfile from "@gl-admin/components/ui/user-profile/UserProfile";
import Icon from "@gl-admin/components/ui/Icon";
import SidebarPopup from "./SidebarPopup";
import SidebarItem from "./SidebarItem";

export default function SidebarUserProfile() {
    const auth = authManager.getState();
    const {
        open,
        setOpen,
        ref,
        handleSelectClick,
    } = useSelect()

    const handleLogout = async () => {
        authManager.logout();
        await api.logout({ refresh_token: auth.refreshToken });
        setOpen(false);
        window.location.href = "/login";
    }

    const footer = (
        <>
            <div className="version">v1.0.0</div>
            <div className="terms">Terms & Conditions</div>
        </>
    );

    return (
        <section className="sidebar-user-profile" ref={ref}>
            <UserProfile user={auth.user} hover={false}>
                <Icon name="options" color="#46484A" onClick={handleSelectClick} className={`user-profile__icon ${open ? "hovered" : ""}`} />
            </UserProfile>
            <SidebarPopup open={open} footer={footer}>
                <SidebarItem iconPath="logout" name="Logout" onClick={handleLogout} />
            </SidebarPopup>
        </section >
    );
}