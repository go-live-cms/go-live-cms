import Icon from "./Icon";
import "@gl-admin/assets/styles/components/ui/post-status.scss";

function capitalize(str: string | null) {
    if (!str) return "";
    return str.charAt(0).toUpperCase() + str.slice(1);
}

export default function PostStatus({ status, iconPath }: { status: string | null, iconPath: string | null }) {

    const getStatusColor = () => {
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
    };

    return (
        <span className={`gl-post-status ${status}`} style={{ color: getStatusColor() }}>
            {iconPath && <Icon name={iconPath} alt={status || ""} color={getStatusColor()} width="1.125rem" height="1.125rem" className="gl-post-status-icon" />}
            {capitalize(status)}
        </span>
    )
}
