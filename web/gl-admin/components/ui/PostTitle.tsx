import type { JSX } from 'react';
import type { Post } from "@gl-admin/lib/types";
import { formatRelativeDay } from '@gl-admin/utils/formatting';

export default function PostTitle({ value }: { value: Post }): JSX.Element {
    const isNeverEdited = !value.changed_at || value.changed_at === "0001-01-01T00:00:00Z";

    return (
        <div className="gl-table__heading">
            <span className="gl-table__heading-title">{value.title}</span>
            <span className="gl-table__heading-description">
                By {value.username} •{" "}
                {isNeverEdited
                    ? <>Created {formatRelativeDay(value.created_at)}</>
                    : <>Last edited {formatRelativeDay(value.changed_at)}</>
                }
            </span>
        </div>
    );
}