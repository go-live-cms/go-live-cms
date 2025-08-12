import type { ReactNode } from 'react';
import "@assets/styles/admin/ui/table.scss";

// Column definition type
export type TableColumn<T> = {
  key: keyof T;
  name: string;
};

// Table column with optional render prop for slot-like customization
export type TableColumnWithRender<T> = {
  key: keyof T;
  name: string;
  width?: string | number;
  render?: (value: T[keyof T], row: T) => ReactNode;
};

export interface TableProps<T> {
  columns: TableColumnWithRender<T>[];
  data: T[];
  className?: string;
}

export default function Table<T extends Record<string, any>>({
  columns,
  data,
  className = '',
}: TableProps<T>) {

  return (
    <table className={`gl-table ${className}`}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th
              key={String(col.key)}
              style={col.width ? { width: typeof col.width === 'number' ? `${col.width}` : col.width } : undefined}
            >
              {col.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row, rowIdx) => (
          <tr key={rowIdx}>
            {columns.map((col) => (
              <td
                key={String(col.key)}
                style={col.width ? { width: typeof col.width === 'number' ? `${col.width}` : col.width } : undefined}
              >
                {col.render
                  ? col.render(row[col.key], row)
                  : String(row[col.key])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
