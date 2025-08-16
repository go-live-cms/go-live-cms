import React, { useEffect, useState } from "react";

interface Props {
  name: string; // e.g., 'arrow-right'
  color?: string;
  className?: string;
  width?: string;
  height?: string;
  alt?: string;
  mirror_horizontally?: boolean;
  mirror_vertically?: boolean;
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
}) => {
  const [svgContent, setSvgContent] = useState<string>("");

  useEffect(() => {
    let isMounted = true;

    // Dynamic import for SVG as raw text
    import(`@assets/icons/${name}.svg?raw`)
      .then((Svg) => {
        let content = Svg.default as string;

        // Replace stroke and fill attributes if they are not 'none'
        content = content.replace(/stroke="(?!none")[^"]*"/g, `stroke="${color}"`);
        content = content.replace(/fill="(?!none")[^"]*"/g, `fill="${color}"`);
        // Replace width and height attributes and add className
        content = content.replace(
          /<svg /,
          `<svg width="${width}" height="${height}" class="${className}" `
        );

        if (isMounted) setSvgContent(content);
      })
      .catch(() => setSvgContent("")); // Handle missing SVG

    return () => {
      isMounted = false;
    };
  }, [name, color, className, width, height]);

  // Compute transform for mirroring
  const scaleX = mirror_horizontally ? -1 : 1;
  const scaleY = mirror_vertically ? -1 : 1;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--color, black)",
        transform: `scaleX(${scaleX}) scaleY(${scaleY})`, // Updated line
      }}
      aria-label={alt}
      dangerouslySetInnerHTML={{ __html: svgContent }}
    />
  );
};

export default Icon;