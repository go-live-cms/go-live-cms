import { forwardRef, useMemo, useState, useCallback, useEffect, type InputHTMLAttributes, type ReactNode } from "react"
import { getInputMask, getValidationPattern, type InputMaskType } from "@gl-admin/utils/inputMasks"
import "@gl-admin/assets/styles/components/ui/input.scss"

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "title" | "type"> & {
  // The visible label, above the field.
  title: string
  type?: InputMaskType
  containerClassName?: string
  // Helper text under the field.
  hint?: ReactNode
  // An error message: marks the field invalid and replaces the hint. Name the fix
  // ("“maya@golive” isn't a complete email address.").
  error?: ReactNode
  // Adds "(optional)" after the label.
  optional?: boolean
  // Hides the label visually (keeps it for screen readers), e.g. a search box.
  hideLabel?: boolean
  // A plain input: no mask and no pattern check, for free text the API validates (a
  // site title, a label). The masks refuse characters such as ! & : and ?.
  unmasked?: boolean
}

export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} className="gl-field__error">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
      {children}
    </span>
  )
}

// The line under a field: the error when there is one, otherwise the hint. Its ids are
// the ones describedBy points at.
export function FieldMessage({ id, hint, error }: { id: string; hint?: ReactNode; error?: ReactNode }) {
  if (error) return <FieldError id={`${id}-error`}>{error}</FieldError>
  if (!hint) return null
  return (
    <span id={`${id}-hint`} className="gl-field__hint">
      {hint}
    </span>
  )
}

// The ids aria-describedby should point at for a field's hint and error.
export function describedBy(id: string, hint: unknown, error: unknown, extra?: string) {
  return [error ? `${id}-error` : hint ? `${id}-hint` : "", extra ?? ""].filter(Boolean).join(" ") || undefined
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      title,
      type = "text",
      name,
      value,
      defaultValue,
      className,
      containerClassName,
      hint,
      error,
      optional,
      hideLabel,
      unmasked = false,
      placeholder,
      onFocus,
      onBlur,
      onKeyDown,
      onChange,
      id,
      "aria-describedby": ariaDescribedBy,
      ...rest
    },
    ref
  ) => {
    const [focused, setFocused] = useState(false)
    const [filled, setFilled] = useState(() => (value ?? defaultValue ?? "") !== "")
    const [IMaskInput, setIMaskInput] = useState<any>(null)
    const [hydrated, setHydrated] = useState(false)

    useEffect(() => {
      setHydrated(true)
      import("react-imask").then((mod) => {
        setIMaskInput(() => mod.IMaskInput)
      })
    }, [])

    const isFilled = useMemo(() => {
      if (value !== undefined) return String(value) !== ""
      return filled
    }, [value, filled])

    const handleFocus = useCallback<NonNullable<typeof onFocus>>(
      (e) => {
        setFocused(true)
        onFocus?.(e)
      },
      [onFocus]
    )

    const handleBlur = useCallback<NonNullable<typeof onBlur>>(
      (e) => {
        setFocused(false)
        if (value === undefined) setFilled(e.currentTarget.value !== "")
        onBlur?.(e)
      },
      [onBlur, value]
    )

    const isValid = useCallback(() => {
      if (unmasked || value === undefined || value === "") return true
      return getValidationPattern(type).test(value as string)
    }, [type, value, unmasked])

    function sanitizeInput(value: string) {
      return value.replace(/<[^>]*>?/gm, "")
    }

    const handleChange = useCallback<NonNullable<typeof onChange>>(
      (e) => {
        const sanitizedValue = sanitizeInput(e.currentTarget.value)
        if (value === undefined) setFilled(sanitizedValue !== "")
        if (onChange) {
          const event = {
            ...e,
            currentTarget: {
              ...e.currentTarget,
              value: sanitizedValue,
            },
            target: {
              ...e.target,
              value: sanitizedValue,
            },
          }
          onChange(event as any)
        }
      },
      [onChange, value]
    )

    const handleKeyDown = useCallback<NonNullable<typeof onKeyDown>>(
      (e) => {
        if (!onKeyDown) return
        const sanitizedValue = sanitizeInput((e.currentTarget as HTMLInputElement).value)
        const event = {
          ...e,
          currentTarget: {
            ...e.currentTarget,
            value: sanitizedValue,
          },
          target: {
            ...(e.target as any),
            value: sanitizedValue,
          },
        }
        onKeyDown(event as any)
      },
      [onKeyDown]
    )

    const inputId = id ?? `input-${name || type}`
    const invalid = Boolean(error) || !isValid()

    return (
      <div
        className={[
          "gl-input",
          focused ? "is-focused" : "",
          isFilled ? "is-filled" : "",
          invalid ? "is-invalid" : "",
          containerClassName || "",
          className || "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {unmasked ? (
          <input
            id={inputId}
            ref={ref}
            type={type === "password" ? "password" : "text"}
            className="gl-input__field"
            name={name}
            placeholder={placeholder}
            value={value}
            defaultValue={defaultValue}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy(inputId, hint, error, ariaDescribedBy)}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            onChange={handleChange}
            {...rest}
          />
        ) : /* The masked input loads lazily; hold its place until it does. */ !hydrated || !IMaskInput ? (
          <span className="gl-input__field" aria-hidden="true" />
        ) : (
          <IMaskInput
            id={inputId}
            ref={ref}
            type={type === "password" ? "password" : "text"}
            className="gl-input__field"
            placeholder={placeholder}
            value={value as any}
            defaultValue={defaultValue}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy(inputId, hint, error, ariaDescribedBy)}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            onChange={handleChange}
            onAccept={(value: string) => {
              if (onChange) {
                const sanitizedValue = sanitizeInput(value)
                onChange({
                  target: { value: sanitizedValue },
                  currentTarget: { value: sanitizedValue },
                } as any)
              }
            }}
            {...getInputMask(type)}
            {...rest}
          />
        )}
        <label className={`gl-input__label${hideLabel ? " gl-visually-hidden" : ""}`} htmlFor={inputId}>
          {title}
          {optional && <span className="gl-input__optional"> (optional)</span>}
        </label>
        <FieldMessage id={inputId} hint={hint} error={error} />
      </div>
    )
  }
)

Input.displayName = "Input"
export default Input
