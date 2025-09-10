import { useState, useRef, useEffect } from "react";

export function useSelect(disabled: boolean = false) {
    const [open, setOpen] = useState(false);
    const [optionsStyle, setOptionsStyle] = useState<React.CSSProperties>({});
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const handleSelectClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (disabled) return;
        const mouseY = e.clientY;
        const viewportHeight = window.innerHeight;
        const showAbove = mouseY > viewportHeight * 0.5;

        setOptionsStyle({
            top: showAbove ? undefined : "100%",
            bottom: showAbove ? "100%" : undefined,
        });

        setOpen((o) => !o);
    };

    return {
        open,
        setOpen,
        optionsStyle,
        ref,
        handleSelectClick,
    };
}