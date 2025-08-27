import Icon from "./Icon";
import { capitalize } from "@gl-admin/utils/formatting";
import "@gl-admin/assets/styles/components/ui/post-type.scss";

export default function PostType({ type, iconPath }: { type: string | null, iconPath: string | null }) {

    const getTypeColor = () => {
        switch (type) {
            case "page":
                return "#006effff";
            case "post":
                return "#AE00FF";
            default:
                return "black";
        }
    };

    if (!type || !iconPath) {
        return <span className="gl-post-type skeleton"></span>;
    }

    return (
        <span className={`gl-post-type ${type}`}>
            {iconPath && <Icon name={iconPath} alt={type || ""} color={getTypeColor()} width="1.8rem" height="1.8rem" className="gl-post-status-icon" />}
            {capitalize(type)}
        </span>
    )
}
