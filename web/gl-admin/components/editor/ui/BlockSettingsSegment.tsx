// One radio group of the settings panel's Block tab: a label and its choices.
export default function Segment<T extends string>({
  label,
  values,
  labels,
  value,
  onPick,
  disabled,
}: {
  label: string
  values: readonly T[]
  labels: Record<T, string>
  value: T
  onPick: (value: T) => void
  disabled?: (value: T) => boolean
}) {
  const id = `block-settings-${label.toLowerCase().replace(/\s+/g, "-")}`
  return (
    <div className="post-settings__field">
      <span className="post-settings__label" id={id}>
        {label}
      </span>
      <div className="block-settings__segment" role="radiogroup" aria-labelledby={id}>
        {values.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === value}
            className="block-settings__option"
            disabled={disabled?.(option)}
            onClick={() => onPick(option)}
          >
            {labels[option]}
          </button>
        ))}
      </div>
    </div>
  )
}
