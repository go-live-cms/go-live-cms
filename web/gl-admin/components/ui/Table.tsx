import type { ReactNode } from "react"
import "@gl-admin/assets/styles/components/ui/table.scss"

export type TableColumn<T> = {
  key: keyof T
  name: string
}

export type TableColumnWithRender<T> = {
  key: keyof T
  name: string
  width?: string | number
  render?: (value: T[keyof T] | null, row: T | null) => ReactNode
}

export interface TableProps<T> {
  columns: TableColumnWithRender<T>[]
  loading?: boolean
  data: T[]
  className?: string
}

export default function Table<T extends Record<string, any>>({ columns, data, loading = false, className = "" }: TableProps<T>) {

  const dataSkeleton = (
    <tbody>
      {Array.from({ length: 8 }).map((_, rowIdx) => (
        <tr key={rowIdx}>
          {columns.map((col) => (
            <td
              key={String(col.key)}
              style={col.width ? { width: typeof col.width === "number" ? `${col.width}` : col.width } : undefined}
            >
              {col.render ? col.render(null, null) : <div className="skeleton">&nbsp;</div>}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  )

  const dataRender = (
    <tbody>
      {data.map((row, rowIdx) => (
        <tr key={rowIdx}>
          {columns.map((col) => (
            <td
              key={String(col.key)}
              style={col.width ? { width: typeof col.width === "number" ? `${col.width}` : col.width } : undefined}
            >
              {col.render ? col.render(row[col.key], row) : String(row[col.key])}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  )
  return (
    <table className={`gl-table ${className}`}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th
              key={String(col.key)}
              style={col.width ? { width: typeof col.width === "number" ? `${col.width}` : col.width } : undefined}
            >
              {col.name}
            </th>
          ))}
        </tr>
      </thead>
      {loading ? dataSkeleton : dataRender}
    </table>
  )
}
