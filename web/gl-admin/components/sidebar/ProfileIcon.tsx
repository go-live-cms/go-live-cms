import { getInitials } from "@gl-admin/utils/formatting";
import "@gl-admin/assets/styles/components/sidebar/profile-icon.scss";

type ProfileIconProps = {
    fullName: string;
    hovered: boolean;
};

export default function ProfileIcon({ fullName, hovered }: ProfileIconProps) {
    const initials = getInitials(fullName);

    return (
        <div className="profile-icon__wrapper">
            <div className={`profile-icon ${hovered ? "hovered" : ""}`}>
                <span>{initials}</span>
            </div>
        </div>
    );
}