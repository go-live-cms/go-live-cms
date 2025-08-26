import "@gl-admin/assets/styles/layouts/listing.scss";
import React from "react";

type ListingProps = {
    title: string;
    children: React.ReactNode;
    actions?: React.ReactNode;
}

export default function Listing({ title, children, actions }: ListingProps) {
    return (
        <section className="gl-listing">
            <div className="gl-listing__heading">
                <h1>{title}</h1>
                <div className="gl-listing__actions">
                    {actions}
                </div>
            </div>
            <div className="gl-listing__content">{children}</div>
        </section>
    );
}