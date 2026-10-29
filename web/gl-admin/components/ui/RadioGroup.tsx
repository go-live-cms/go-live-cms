import type { ReactNode } from "react"
import { useStableId } from "@gl-admin/components/ui/a11y"
import "@gl-admin/assets/styles/components/ui/choice.scss"

export type RadioOption = {
  value: string
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}

type RadioGroupProps = {
  legend: ReactNode
  options: RadioOption[]
  value: string
  onChange: (value: string) => void
  name?: string
  // "card": each option is a bordered box, selected one tinted (the invite dialog's roles).
  variant?: "plain" | "card"
  disabled?: boolean
  className?: string
}

// Native radios in a fieldset: arrow keys move the selection, Tab leaves the group.
export default function RadioGroup({
  legend,
  options,
  value,
  onChange,
  name,
  variant = "plain",
  disabled = false,
  className = "",
}: RadioGroupProps) {
  const groupName = useStableId("radio", name)

  return (
    <fieldset className={`gl-radio-group gl-radio-group--${variant} ${className}`} disabled={disabled}>
      <legend className="gl-radio-group__legend">{legend}</legend>
      {options.map((opt) => (
        <label
          key={opt.value}
          className={`gl-choice${opt.value === value ? " is-checked" : ""}${opt.disabled ? " is-disabled" : ""}`}
        >
          <input
            type="radio"
            className="gl-radio"
            name={groupName}
            value={opt.value}
            checked={opt.value === value}
            disabled={opt.disabled}
            onChange={() => onChange(opt.value)}
          />
          <span className="gl-choice__text">
            <span className="gl-choice__label">{opt.label}</span>
            {opt.description && <span className="gl-choice__description">{opt.description}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  )
}
