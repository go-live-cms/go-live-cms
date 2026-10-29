import type { CSSProperties, ReactNode } from "react"
import Checkbox from "@gl-admin/components/ui/Checkbox"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import "@gl-admin/assets/styles/components/ui/table.scss"

export type TableColumn<T> = {
  key: keyof T
  name: string
}

export type TableColumnWithRender<T> = {
  key: keyof T
  name: string
  width?: string | number
  // Right-aligns the column (counts, dates) with tabular numbers.
  numeric?: boolean
  render?: (value: T[keyof T] | null, row: T | null) => ReactNode
}

type RowKey = string | number

export interface TableProps<T> {
  columns: TableColumnWithRender<T>[]
  loading?: boolean
  data: T[]
  className?: string
  onRowDoubleClick?: (row: T) => void
  // Names the table for screen readers when no heading does.
  "aria-label"?: string
  // Row selection: a checkbox column, with select-all in the header.
  selectable?: boolean
  selectedKeys?: RowKey[]
  onSelectionChange?: (keys: RowKey[]) => void
  // How rows are identified for selection and React keys; defaults to row.id, then index.
  rowKey?: (row: T, index: number) => RowKey
  // Describes a row in its checkbox's label ("Select <title>"); defaults to "row n".
  rowLabel?: (row: T, index: number) => string
  // Scroll the table inside a box this tall, with the header stuck to its top. (The
  // box scrolls sideways for wide tables, so the header can't stick to the page.)
  maxHeight?: string | number
  // Extra classes for a row, e.g. "is-current" for the one open in a side panel.
  rowClassName?: (row: T) => string | undefined
}

function widthStyle(width?: string | number): CSSProperties | undefined {
  return width ? { width: typeof width === "number" ? `${width}px` : width } : undefined
}

export default function Table<T extends Record<string, any>>({
  columns,
  data,
  loading = false,
  className = "",
  onRowDoubleClick,
  selectable = false,
  selectedKeys = [],
  onSelectionChange,
  rowKey = (row, index) => row.id ?? index,
  rowLabel = (_row, index) => `row ${index + 1}`,
  maxHeight,
  rowClassName,
  ...aria
}: TableProps<T>) {
  const keys = data.map(rowKey)
  const selected = new Set(selectedKeys)
  const selectedCount = keys.filter((k) => selected.has(k)).length
  const allSelected = keys.length > 0 && selectedCount === keys.length

  const toggle = (key: RowKey, on: boolean) => {
    const next = new Set(selected)
    if (on) next.add(key)
    else next.delete(key)
    onSelectionChange?.([...next])
  }
  const toggleAll = (on: boolean) => {
    const next = new Set(selected)
    keys.forEach((k) => (on ? next.add(k) : next.delete(k)))
    onSelectionChange?.([...next])
  }

  const cellClass = (col: TableColumnWithRender<T>) => (col.numeric ? "gl-table__cell--numeric" : undefined)

  // Functions, not elements: column renderers only get (null, null) while loading.
  const skeletonRows = () => (
    <tbody aria-hidden="true">
      {Array.from({ length: 8 }).map((_, rowIdx) => (
        <tr key={rowIdx}>
          {selectable && (
            <td className="gl-table__select">
              <Skeleton width={16} height={16} />
            </td>
          )}
          {columns.map((col) => (
            <td key={String(col.key)} className={cellClass(col)} style={widthStyle(col.width)}>
              {col.render ? col.render(null, null) : <Skeleton shape="text" width={`${50 + ((rowIdx * 17) % 40)}%`} />}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  )

  const rows = () => (
    <tbody>
      {data.map((row, rowIdx) => {
        const key = keys[rowIdx]
        const isSelected = selected.has(key)
        return (
          <tr
            key={key}
            aria-selected={selectable ? isSelected : undefined}
            className={[isSelected ? "is-selected" : "", onRowDoubleClick ? "is-clickable" : "", rowClassName?.(row) ?? ""].filter(Boolean).join(" ") || undefined}
            onDoubleClick={() => onRowDoubleClick?.(row)}
          >
            {selectable && (
              <td className="gl-table__select">
                <Checkbox
                  checked={isSelected}
                  aria-label={`Select ${rowLabel(row, rowIdx)}`}
                  onChange={(on) => toggle(key, on)}
                />
              </td>
            )}
            {columns.map((col) => (
              <td key={String(col.key)} className={cellClass(col)} style={widthStyle(col.width)}>
                {col.render ? col.render(row[col.key], row) : String(row[col.key])}
              </td>
            ))}
          </tr>
        )
      })}
    </tbody>
  )

  return (
    <div
      className={`gl-table-scroll${maxHeight !== undefined ? " gl-table-scroll--bounded" : ""}`}
      style={maxHeight !== undefined ? { maxHeight } : undefined}
      aria-busy={loading || undefined}
    >
      <table className={`gl-table ${className}`} aria-label={aria["aria-label"]}>
        <thead>
          <tr>
            {selectable && (
              <th scope="col" className="gl-table__select">
                <Checkbox
                  aria-label="Select all"
                  checked={allSelected}
                  indeterminate={selectedCount > 0 && !allSelected}
                  disabled={loading || keys.length === 0}
                  onChange={toggleAll}
                />
              </th>
            )}
            {columns.map((col) => (
              <th key={String(col.key)} scope="col" className={cellClass(col)} style={widthStyle(col.width)}>
                {col.name}
              </th>
            ))}
          </tr>
        </thead>
        {loading ? skeletonRows() : rows()}
      </table>
    </div>
  )
}
