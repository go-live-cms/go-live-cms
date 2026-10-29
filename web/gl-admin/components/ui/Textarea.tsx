import { forwardRef, type ReactNode, type TextareaHTMLAttributes } from "react"
import { FieldError, describedBy } from "@gl-admin/components/ui/Input"
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
  { label, hint, error, optional, maxCount, containerClassName = "", id, rows = 3, value, defaultValue, className = "", ...rest },
  ref
) {
  const fieldId = useStableId("textarea", id)
  const count = String(value ?? defaultValue ?? "").length
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
        {...rest}
      />
      {error ? (
        <FieldError id={`${fieldId}-error`}>{error}</FieldError>
      ) : (
        hint && (
          <span id={`${fieldId}-hint`} className="gl-field__hint">
            {hint}
          </span>
        )
      )}
    </div>
  )
})

export default Textarea
