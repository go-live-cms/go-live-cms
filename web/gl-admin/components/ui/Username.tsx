import type { JSX } from 'react';
import type { User } from "@gl-admin/lib/api/types";

export default function Username({ value }: { value: User | null }): JSX.Element {

    if (!value) {
        return <div className="gl-table__heading">
            <span className="gl-table__heading-title skeleton" />
            <span className="gl-table__heading-description skeleton" />
        </div>;
    }

    return (
        <div className="gl-table__heading">
            <span className="gl-table__heading-title">{value.full_name}</span>
            <span className="gl-table__heading-description">{value.username}</span>
        </div>
    );
}