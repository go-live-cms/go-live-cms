import Icon from "./Icon"
import { capitalize } from "@gl-admin/utils/formatting"
import "@gl-admin/assets/styles/components/ui/post-type.scss"

export default function PostType({ type, iconPath }: { type: string | null; iconPath: string | null }) {
  // Dynamic color palette for post types
  const TYPE_COLORS: Record<string, string> = {
    page: "#006effff",
    post: "#AE00FF",
  }

  const getTypeColor = () => {
    if (!type) return "black"
    return TYPE_COLORS[type] || stringToColor(type)
  }

  if (!type || !iconPath) {
    return <span className="gl-post-type skeleton"></span>
  }

  return (
    <span className={`gl-post-type ${type}`}>
      {iconPath && (
        <Icon
          name={iconPath}
          alt={type || ""}
          color={getTypeColor()}
          width="1.8rem"
          height="1.8rem"
          className="gl-post-status-icon"
        />
      )}
      {capitalize(type)}
    </span>
  )
}

// Generate a deterministic color from a string
function stringToColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  const h = Math.abs(hash) % 360
  return `hsl(${h}, 65%, 45%)`
}
