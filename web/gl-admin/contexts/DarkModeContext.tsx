import React, { createContext, useContext, useEffect, useState } from "react";

const DarkModeContext = createContext<boolean>(false);

export const useDarkMode = () => useContext(DarkModeContext);

export const DarkModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const getIsDark = () =>
        document.documentElement.getAttribute("data-theme") === "dark";

    const [isDark, setIsDark] = useState(getIsDark());

    useEffect(() => {
        const observer = new MutationObserver(() => {
            setIsDark(getIsDark());
        });

        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["data-theme"],
        });

        return () => observer.disconnect();
    }, []);

    return (
        <DarkModeContext.Provider value={isDark}>
            {children}
        </DarkModeContext.Provider>
    );
};