import React, { createContext, useContext, useEffect, useState } from "react";

type GoLiveContextType = {
    isDark: boolean;
    baseTitle: string;
};

const GoLiveContext = createContext<GoLiveContextType>({
    isDark: false,
    baseTitle: "GoLive Admin | ",
});

export const useGoLive = () => useContext(GoLiveContext);

export const GoLiveProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const getIsDark = () =>
        document.documentElement.getAttribute("data-theme") === "dark";
    const getBaseTitle = () => "GoLive Admin | ";

    const [isDark, setIsDark] = useState(getIsDark());
    const [baseTitle] = useState(getBaseTitle());

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
        <GoLiveContext.Provider value={{ isDark, baseTitle }}>
            {children}
        </GoLiveContext.Provider>
    );
};