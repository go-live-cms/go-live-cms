import React, { useEffect, useState } from "react"
import "@gl-admin/assets/styles/components/ui/icon.scss"

interface Props {
  name: string // e.g., 'arrow-right'
  color?: string
  className?: string
  width?: string
  height?: string
  alt?: string
  mirror_horizontally?: boolean
  mirror_vertically?: boolean
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void
}

export const Icon: React.FC<Props> = ({
  name,
  color = "black",
  className = "",
  width = "32",
  height = "32",
  alt,
  mirror_horizontally = false,
  mirror_vertically = false,
  onClick
}) => {
  const [svgContent, setSvgContent] = useState<string>("")
  const [iconLoaded, setIconLoaded] = useState(false);

  useEffect(() => {
    let isMounted = true

    import(`@gl-admin/assets/icons/${name}.svg?raw`)
      .then((Svg) => {
        let content = Svg.default as string

        // Replace stroke and fill attributes if they are not 'none'
        content = content.replace(/stroke="(?!none")[^"]*"/g, `stroke="${color}"`)
        content = content.replace(/fill="(?!none")[^"]*"/g, `fill="${color}"`)
        // Replace width and height attributes and add className
        content = content.replace(/<svg /, `<svg width="${width}" height="${height}" class="${className}" `)

        if (isMounted) setSvgContent(content)
      })
      .catch(() => setSvgContent("")) // Handle missing SVG
      .finally(() => setIconLoaded(true));

    return () => {
      isMounted = false
    }
  }, [name, color, className, width, height])

  const transforms = []
  if (mirror_horizontally) transforms.push("rotate(180deg)")
  if (mirror_vertically) transforms.push("rotate(180deg)")

  if (!iconLoaded) {
    return <div
      className={`gl-icon skeleton ${className}`}
      style={{ width: `${width}px`, height: `${height}px`, transform: transforms.join(" ") }}
    />
  }

  return (
    <span
      className={`gl-icon ${className}`}
      onClick={onClick}
      style={{
        color: "var(--color, black)",
        transform: transforms.join(" "),
      }}
      aria-label={alt}
      dangerouslySetInnerHTML={{ __html: svgContent }}
    />
  )
}

export function extractSvgPath(svgString: string) {
  const match = svgString.match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
  return match ? match[1] : "";
}

export default Icon
