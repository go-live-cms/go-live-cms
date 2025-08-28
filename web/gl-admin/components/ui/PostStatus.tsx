import Icon from "./Icon";
import { capitalize } from "@gl-admin/utils/formatting";
import "@gl-admin/assets/styles/components/ui/post-status.scss";

export default function PostStatus({ status, iconPath }: { status: string | null, iconPath: string | null }) {

    const getStatusColor = () => {
        const isDark = document.documentElement.getAttribute("data-theme") === "dark";
        if (isDark) {
            switch (status) {
                case "published":
                    return "#71FF71";
                case "draft":
                    return "#FFDF60";
                case "private":
                    return "#888888";
                default:
                    return "#FFFFFF";
            }
        } else {
            switch (status) {
                case "published":
                    return "#0F5E0F";
                case "draft":
                    return "#333536";
                case "private":
                    return "#434343";
                default:
                    return "black";
            }
        }
    };

    if (!status || !iconPath) {
        return <span className="gl-post-status skeleton"></span>;
    }

    return (
        <span className={`gl-post-status ${status}`} style={{ color: getStatusColor() }}>
            {iconPath && <Icon name={iconPath} alt={status || ""} color={getStatusColor()} width="1.125rem" height="1.125rem" className="gl-post-status-icon" />}
            {capitalize(status)}
        </span>
    )
}
