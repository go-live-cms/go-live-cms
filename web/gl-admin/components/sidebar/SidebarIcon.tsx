import React from "react";
import type { IconPath } from "@gl-admin/types/sidebar";

interface SidebarIconProps {
  path: IconPath; // e.g., 'arrow-right'
  color?: string;
  className?: string;
  width?: string;
  height?: string;
  alt?: string;
}

export const SidebarIcon: React.FC<SidebarIconProps> = ({
  path,
  color = "black",
  className = "",
  width = "32",
  height = "32",
  alt,
}) => {
  const [svgContent, setSvgContent] = React.useState<string>("");

  React.useEffect(() => {
    let isMounted = true;
    import(`@gl-admin/assets/icons/${path}.svg?raw`).then((Svg) => {
      let content: string = Svg.default;

      content = content.replace(/stroke="(?!none")[^"]*"/g, `stroke="${color}"`);
      content = content.replace(/fill="(?!none")[^"]*"/g, `fill="${color}"`);

      content = content.replace(
        /<svg /,
        `<svg width="${width}" height="${height}" class="${className}" `
      );

      if (isMounted) setSvgContent(content);
    });

    return () => {
      isMounted = false;
    };
  }, [path, color, className, width, height]);

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--color, black)",
      }}
      dangerouslySetInnerHTML={{ __html: svgContent }}
      aria-label={alt}
    />
  );
};

export default SidebarIcon;