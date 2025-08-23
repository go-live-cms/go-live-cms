import { getInitials } from "@gl-admin/utils/formatting";
import "@gl-admin/assets/styles/components/ui/user-profile/user-profile-icon.scss";

type ProfileIconProps = {
    fullName: string;
    hovered: boolean;
};

export default function ProfileIcon({ fullName, hovered }: ProfileIconProps) {
    const initials = getInitials(fullName);

    return (
        <div className={`user-profile-icon ${hovered ? "hovered" : ""}`}>
            <span>{initials}</span>
        </div>
    );
}