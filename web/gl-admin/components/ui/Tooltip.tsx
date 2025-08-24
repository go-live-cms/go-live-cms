import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import "@gl-admin/assets/styles/components/ui/tooltip.scss";

type Placement = "top" | "bottom" | "left" | "right";

interface TooltipProps {
    content: React.ReactNode;
    placement?: Placement;
    children: React.ReactElement;
}

const Tooltip: React.FC<TooltipProps> = ({
    content,
    placement = "right",
    children,
}) => {
    const [visible, setVisible] = useState(false);
    const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
    const childRef = useRef<HTMLDivElement>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (visible && childRef.current && tooltipRef.current) {
            const rect = childRef.current.getBoundingClientRect();
            const tooltipRect = tooltipRef.current.getBoundingClientRect();

            let top = rect.top + window.scrollY;
            let left = rect.left + window.scrollX;

            switch (placement) {
                case "top":
                    top -= tooltipRect.height + 8;
                    left += rect.width / 2 - tooltipRect.width / 2;
                    break;
                case "bottom":
                    top += rect.height + 8;
                    left += rect.width / 2 - tooltipRect.width / 2;
                    break;
                case "left":
                    left -= tooltipRect.width + 8;
                    top += rect.height / 2 - tooltipRect.height / 2;
                    break;
                case "right":
                default:
                    left += rect.width + 8;
                    top += rect.height / 2 - tooltipRect.height / 2;
                    break;
            }

            setCoords({ top, left });
        }
    }, [visible, placement, content]);

    const adminDiv = document.getElementById("admin");

    return (
        <>
            <div
                ref={childRef}
                onMouseEnter={() => setVisible(true)}
                onMouseLeave={() => setVisible(false)}
                style={{ display: "inline-block" }}
            >
                {children}
            </div>
            {adminDiv &&
                createPortal(
                    <div
                        className={`gl-tooltip ${visible ? "visible" : ""}`}
                        ref={tooltipRef}
                        style={{
                            top: coords.top,
                            left: coords.left,
                        }}
                    >
                        {content}
                    </div>,
                    adminDiv
                )
            }
        </>
    );
};

export default Tooltip;