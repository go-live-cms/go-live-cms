import "@gl-admin/assets/styles/components/sidebar/sidebar-popup.scss";

interface SidebarPopupProps {
    open: boolean;
    children: React.ReactNode;
    header?: React.ReactNode;
    footer?: React.ReactNode;
    ref?: React.Ref<HTMLDivElement>;
}

export default function SidebarPopup({ open, children, header, footer, ref }: SidebarPopupProps) {
    return (
        <div className={`sidebar-popup ${open ? "open" : ""}`} ref={ref}>
            <div className="sidebar-popup__header">
                {header}
            </div>
            <div className="sidebar-popup__body">
                {children}
            </div>
            <div className="sidebar-popup__footer">
                {footer}
            </div>
        </div>
    );
}