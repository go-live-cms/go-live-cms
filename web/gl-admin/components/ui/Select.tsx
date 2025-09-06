import React from "react"
import Icon from "@gl-admin/components/ui/Icon"
import "@gl-admin/assets/styles/components/ui/select.scss"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import { useSelect } from "@gl-admin/utils/select"

export type SelectOption = {
  value: string
  label: string
}

export type SelectProps = {
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
  label?: string
  disabled?: boolean
}

export const Select: React.FC<SelectProps> = ({ options, value, onChange, label, disabled = false }) => {
  const {
    open,
    setOpen,
    optionsStyle,
    ref,
    handleSelectClick,
  } = useSelect(disabled)

  const selected = options.find((opt) => opt.value === value)
  const { isDark } = useGoLive()
  const iconColor = isDark ? "#FFFFFF" : "#333536"

  return (
    <div className="gl-select" ref={ref} style={{ position: "relative" }}>
      {label && <label className="gl-select__label">{label}</label>}
      <div
        className={`gl-select__selected${disabled ? " gl-select__selected--disabled" : ""}`}
        onClick={handleSelectClick}
        tabIndex={0}
        role="button"
        aria-disabled={disabled}
      >
        <span className="gl-select__placeholder">{selected ? selected.label : "Select..."}</span>
        <Icon name="dropdown" mirror_vertically={open} color={iconColor} width="7px" height="4.3px" />
      </div>
      {open && !disabled && (
        <div
          className="gl-select__options"
          style={optionsStyle}
        >
          {options.map((opt) => (
            <div
              key={opt.value}
              className={`gl-select__option${opt.value === value ? " gl-select__option--selected" : ""}`}
              onClick={() => {
                onChange(opt.value)
                setOpen(false)
              }}
              tabIndex={0}
              role="option"
              aria-selected={opt.value === value}
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default Select
