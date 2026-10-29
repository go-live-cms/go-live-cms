import { forwardRef, useState, type ReactNode, type TextareaHTMLAttributes } from "react"
import { FieldMessage, describedBy } from "@gl-admin/components/ui/Input"
import { useStableId } from "@gl-admin/components/ui/a11y"
import "@gl-admin/assets/styles/components/ui/input.scss"

type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "title"> & {
  label: string
  hint?: ReactNode
  error?: ReactNode
  optional?: boolean
  // Shows "n / max" on the label row; going over turns it red (it doesn't block typing).
  maxCount?: number
  containerClassName?: string
}

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, optional, maxCount, containerClassName = "", id, rows = 3, value, defaultValue, className = "", onChange, ...rest },
  ref
) {
  const fieldId = useStableId("textarea", id)
  // Uncontrolled: count what's typed, since there's no value prop to read.
  const [typed, setTyped] = useState(() => String(defaultValue ?? "").length)
  const count = value !== undefined ? String(value).length : typed
  const over = maxCount !== undefined && count > maxCount
  const countId = `${fieldId}-count`

  return (
    <div className={`gl-field ${containerClassName}`}>
      <div className="gl-field__label-row">
        <label className="gl-field__label" htmlFor={fieldId}>
          {label}
          {optional && <span className="gl-input__optional"> (optional)</span>}
        </label>
        {maxCount !== undefined && (
          <span id={countId} className={`gl-field__count${over ? " is-over" : ""}`} aria-live="polite">
            {count} / {maxCount}
          </span>
        )}
      </div>
      <textarea
        ref={ref}
        id={fieldId}
        rows={rows}
        value={value}
        defaultValue={defaultValue}
        className={`gl-textarea__field ${className}`}
        aria-invalid={error || over ? true : undefined}
        aria-describedby={describedBy(fieldId, hint, error, maxCount !== undefined ? countId : undefined)}
        onChange={(e) => {
          if (value === undefined) setTyped(e.currentTarget.value.length)
          onChange?.(e)
        }}
        {...rest}
      />
      <FieldMessage id={fieldId} hint={hint} error={error} />
    </div>
  )
})

export default Textarea
