import { forwardRef, useMemo, useState, useCallback, useEffect, type InputHTMLAttributes } from "react"
import { getInputMask, getValidationPattern, type InputMaskType } from "@gl-admin/utils/inputMasks"
import "@gl-admin/assets/styles/components/ui/input.scss"

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "title" | "type" | "placeholder"> & {
  title: string
  type?: InputMaskType
  containerClassName?: string
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
      onFocus,
      onBlur,
      onKeyDown,
      onChange,
      id,
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
      if (value === undefined || value === "") return true
      return getValidationPattern(type).test(value as string)
    }, [type, value])

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

    return (
      <div
        className={[
          "gl-input",
          focused ? "is-focused" : "",
          isFilled ? "is-filled" : "",
          isValid() ? "" : "is-invalid",
          containerClassName || "",
          className || "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {/* Render nothing until hydrated */}
        {!hydrated || !IMaskInput ? null : (
          <IMaskInput
            id={inputId}
            ref={ref}
            type="text"
            className="gl-input__field"
            placeholder=" "
            value={value as any}
            defaultValue={defaultValue}
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
        <label className="gl-input__label" htmlFor={inputId}>
          {title}
        </label>
      </div>
    )
  }
)

Input.displayName = "Input"
export default Input
