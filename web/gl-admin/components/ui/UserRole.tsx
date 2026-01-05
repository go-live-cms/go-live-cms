import { capitalize } from "@gl-admin/utils/formatting"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import "@gl-admin/assets/styles/components/ui/user-role.scss"

export default function UserRole({ role }: { role: string | null }) {
    const { isDark } = useGoLive()

    const getRoleColor = () => {
        if (isDark) {
            switch (role) {
                case "admin":
                    return "#FF7171"
                case "moderator":
                    return "#FFB671"
                case "author":
                    return "#71D4FF"
                case "editor":
                    return "#B571FF"
                case "viewer":
                    return "#888888"
                default:
                    return "#FFFFFF"
            }
        } else {
            switch (role) {
                case "admin":
                    return "#C41E3A"
                case "moderator":
                    return "#D97706"
                case "author":
                    return "#0369A1"
                case "editor":
                    return "#7C3AED"
                case "viewer":
                    return "#6B7280"
                default:
                    return "black"
            }
        }
    }

    if (!role) {
        return <span className="gl-user-role skeleton"></span>
    }

    return (
        <span className={`gl-user-role ${role}`} style={{ color: getRoleColor() }}>
            {capitalize(role)}
        </span>
    )
}
