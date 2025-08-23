import { useState, useRef, useEffect } from "react";

export function useSelect(disabled: boolean = false) {
    const [open, setOpen] = useState(false);
    const [showAbove, setShowAbove] = useState(false);
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
        setShowAbove(mouseY > viewportHeight * 0.5);
        setOpen((o) => !o);
    };

    return {
        open,
        setOpen,
        showAbove,
        setShowAbove,
        ref,
        handleSelectClick,
    };
}