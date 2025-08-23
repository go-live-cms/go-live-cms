import { useState } from "react";
import { formatUserName } from "@gl-admin/utils/formatting";
import ProfileIcon from "./UserProfileIcon";
import "@gl-admin/assets/styles/components/ui/user-profile/user-profile.scss";

interface UserProfileProps {
    user: {
        full_name: string;
    } | null;
    hover?: boolean;
    ref?: React.Ref<HTMLDivElement>;
    onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
    children?: React.ReactNode;
    className?: string;
}

export default function UserProfile({ user, ref, hover = true, onClick, className, children }: UserProfileProps) {
    const [hovered, setHovered] = useState(false);

    const handleMouseEnter = () => {
        if (hover) {
            setHovered(true);
        }
    }

    const handleMouseLeave = () => {
        if (hover) {
            setHovered(false);
        }
    }

    if (!user) return null;

    return (
        <div
            className={`user-profile ${className}`}
            ref={ref}
            onClick={onClick}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            <div className="user-profile__profile">
                <ProfileIcon fullName={user.full_name} hovered={hovered} />
            </div>
            <div className="user-profile__name">
                {formatUserName(user.full_name)}
            </div>
            <div className={`user-profile__actions ${hovered ? "hovered" : ""}`}>
                {children}
            </div>
        </div>
    );
}