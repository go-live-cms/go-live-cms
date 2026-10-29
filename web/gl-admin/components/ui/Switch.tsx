import type { ReactNode } from "react"
import { useStableId } from "@gl-admin/components/ui/a11y"
import "@gl-admin/assets/styles/components/ui/choice.scss"

type SwitchProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  // Visible label; without one, pass aria-label.
  label?: ReactNode
  description?: ReactNode
  "aria-label"?: string
  disabled?: boolean
  id?: string
  className?: string
}

// An on/off setting that applies at once (no Save). Space and Enter toggle it, as on
// any button. Label and description sit to the left, the switch on the right.
export default function Switch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  id,
  className = "",
  ...aria
}: SwitchProps) {
  const switchId = useStableId("switch", id)

  const button = (
    <button
      type="button"
      role="switch"
      id={switchId}
      className="gl-switch"
      aria-checked={checked}
      aria-labelledby={label ? `${switchId}-label` : undefined}
      aria-describedby={description ? `${switchId}-description` : undefined}
      aria-label={aria["aria-label"]}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="gl-switch__knob" aria-hidden="true" />
    </button>
  )

  if (!label) return button

  return (
    <div className={`gl-switch-row${disabled ? " is-disabled" : ""} ${className}`}>
      <span className="gl-choice__text">
        <span id={`${switchId}-label`} className="gl-choice__label">
          {label}
        </span>
        {description && (
          <span id={`${switchId}-description`} className="gl-choice__description">
            {description}
          </span>
        )}
      </span>
      {button}
    </div>
  )
}
