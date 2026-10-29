import { forwardRef, useEffect, useImperativeHandle, useRef, type ChangeEvent, type InputHTMLAttributes, type ReactNode } from "react"
import "@gl-admin/assets/styles/components/ui/choice.scss"

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> & {
  // Visible label. Without one, pass aria-label (e.g. "Select all" in a table header).
  label?: ReactNode
  description?: ReactNode
  // The "some selected" state of a select-all box.
  indeterminate?: boolean
  onChange?: (checked: boolean, event: ChangeEvent<HTMLInputElement>) => void
}

const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, indeterminate = false, onChange, className = "", ...rest },
  ref
) {
  const inner = useRef<HTMLInputElement>(null)
  useImperativeHandle(ref, () => inner.current as HTMLInputElement)

  // indeterminate has no HTML attribute; it's a DOM property only.
  useEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate
  }, [indeterminate])

  const input = (
    <input
      ref={inner}
      type="checkbox"
      className={label ? "gl-checkbox" : `gl-checkbox ${className}`}
      aria-checked={indeterminate ? "mixed" : undefined}
      onChange={(e) => onChange?.(e.currentTarget.checked, e)}
      {...rest}
    />
  )

  if (!label) return input

  return (
    <label className={`gl-choice ${className}`}>
      {input}
      <span className="gl-choice__text">
        <span className="gl-choice__label">{label}</span>
        {description && <span className="gl-choice__description">{description}</span>}
      </span>
    </label>
  )
})

export default Checkbox
