import type { JSX } from 'react';
import type { Post } from "@gl-admin/lib/types";
import { formatDate, formatTime } from "@gl-admin/utils/formatting";

export default function PostDateTime({ value }: { value: Post["created_at"] | Post["changed_at"] }): JSX.Element {
    return (
        <time className="gl-table__date">
            <span>{formatDate(value)}</span>
            <span>{formatTime(value)}</span>
        </time>
    )
}