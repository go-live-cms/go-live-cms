import type { ReactNode } from "react"
import { useStableId } from "@gl-admin/components/ui/a11y"
import "@gl-admin/assets/styles/components/ui/segmented-control.scss"

export type SegmentedOption<T extends string> = { value: T; label: ReactNode }

type SegmentedControlProps<T extends string> = {
  legend: ReactNode
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  // Kept for screen readers when a heading beside it already says what it is.
  hideLegend?: boolean
  hint?: ReactNode
  // The options share the row's whole width (the editor's Discussion section, #527).
  block?: boolean
  disabled?: boolean
  name?: string
  className?: string
}

// A choice of a few values drawn as a segmented control (#527: Settings › Discussion's
// Replies and Order, the editor's Discussion section): native radios in a fieldset, so
// arrow keys move the selection and Tab leaves the group, as RadioGroup's.
export default function SegmentedControl<T extends string>({
  legend,
  options,
  value,
  onChange,
  hideLegend = false,
  hint,
  block = false,
  disabled = false,
  name,
  className = "",
}: SegmentedControlProps<T>) {
  const groupName = useStableId("segmented", name)
  const hintId = `${groupName}-hint`
  return (
    <fieldset
      className={`gl-segmented-control${block ? " is-block" : ""} ${className}`}
      disabled={disabled}
      aria-describedby={hint ? hintId : undefined}
    >
      <legend className={hideLegend ? "gl-segmented-control__legend is-hidden" : "gl-segmented-control__legend"}>{legend}</legend>
      <div className="gl-segmented-control__options">
        {options.map((option) => (
          <label key={option.value} className={`gl-segmented-control__option${option.value === value ? " is-checked" : ""}`}>
            <input
              type="radio"
              name={groupName}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
      {hint && (
        <span id={hintId} className="gl-field__hint">
          {hint}
        </span>
      )}
    </fieldset>
  )
}
