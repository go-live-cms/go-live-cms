import type { FC } from "react"
import { useFloating, useStableId } from "@gl-admin/components/ui/a11y"
import { Listbox, optionId, useSelectListbox, type SelectOption } from "@gl-admin/components/ui/Select"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import { ChevronDownIcon } from "@gl-admin/components/ui/icons"
import "@gl-admin/assets/styles/components/ui/select.scss"

interface FilterSelectProps {
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
  // Names the filter, shown before the value ("Status: Published").
  prefix?: string
  disabled?: boolean
  loading?: boolean
}

// A compact select for list filters and sorting, sized like a 32px secondary button.
// Same keyboard as Select.
const FilterSelect: FC<FilterSelectProps> = ({ options, value, onChange, prefix, disabled = false, loading = false }) => {
  const listId = useStableId("filter")
  const lb = useSelectListbox(options, value, onChange, disabled)
  const { style } = useFloating(lb.triggerRef, lb.listRef, lb.open, "bottom-start", { matchWidth: true })
  const selected = options.find((opt) => opt.value === value)

  if (loading) {
    return <Skeleton width={120} height={32} className="gl-filter-select gl-filter-select--loading" />
  }

  return (
    <div className="gl-filter-select">
      <button
        ref={lb.triggerRef}
        type="button"
        role="combobox"
        className="gl-filter-select__control"
        aria-haspopup="listbox"
        aria-expanded={lb.open}
        aria-controls={lb.open ? listId : undefined}
        aria-activedescendant={lb.open && lb.active >= 0 ? optionId(listId, lb.active) : undefined}
        aria-label={prefix ? `${prefix} ${selected?.label ?? ""}`.trim() : undefined}
        disabled={disabled}
        onClick={lb.toggle}
        onKeyDown={lb.onKeyDown}
      >
        {prefix && <span className="gl-filter-select__prefix">{prefix}</span>}
        <span className="gl-filter-select__value">{selected ? selected.label : "Select…"}</span>
        <ChevronDownIcon size={14} className="gl-select__chevron" />
      </button>
      {lb.open && (
        <Listbox
          ref={lb.listRef}
          id={listId}
          label={prefix}
          options={options}
          value={value}
          activeIndex={lb.active}
          onPick={lb.pick}
          onHover={lb.setActive}
          style={style}
        />
      )}
    </div>
  )
}

export default FilterSelect
