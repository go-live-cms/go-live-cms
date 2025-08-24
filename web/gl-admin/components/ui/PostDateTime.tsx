import type { JSX } from 'react';
import type { Post } from "@gl-admin/lib/types";
import { formatDate, formatTime } from "@gl-admin/utils/formatting";

export default function PostDateTime({ value }: { value: Post["created_at"] | Post["changed_at"] | null }): JSX.Element {

    if (!value) {
        return <time className="gl-table__date skeleton"></time>;
    }

    return (
        <time className="gl-table__date">
            <span>{formatDate(value)}</span>
            <span>{formatTime(value)}</span>
        </time>
    )
}