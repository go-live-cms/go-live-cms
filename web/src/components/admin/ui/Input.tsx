import {
    forwardRef,
    useMemo,
    useState,
    useCallback,
    useId,
    type InputHTMLAttributes,
    type HTMLInputTypeAttribute,
} from "react";
import "@assets/styles/admin/ui/input.scss";

export type InputProps = Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "title" | "type"
> & {
    title: string;
    type?: HTMLInputTypeAttribute;
    containerClassName?: string;
};

const Input = forwardRef<HTMLInputElement, InputProps>(
    (
        {
            title,
            type = "text",
            value,
            defaultValue,
            className,
            containerClassName,
            onFocus,
            onBlur,
            onChange,
            id,
            ...rest
        },
        ref
    ) => {
        const [focused, setFocused] = useState(false);
        const [filled, setFilled] = useState(
            () => (value ?? defaultValue ?? "") !== ""
        );

        // Keep "filled" in sync for controlled usage
        const isFilled = useMemo(() => {
            if (value !== undefined) return String(value) !== "";
            return filled;
        }, [value, filled]);

        const handleFocus = useCallback<NonNullable<typeof onFocus>>(
            (e) => {
                setFocused(true);
                onFocus?.(e);
            },
            [onFocus]
        );

        const handleBlur = useCallback<NonNullable<typeof onBlur>>(
            (e) => {
                setFocused(false);
                if (value === undefined) setFilled(e.currentTarget.value !== "");
                onBlur?.(e);
            },
            [onBlur, value]
        );

        function sanitizeInput(value: string) {
            return value.replace(/<[^>]*>?/gm, "");
        }

        const handleChange = useCallback<NonNullable<typeof onChange>>(
            (e) => {
                const sanitizedValue = sanitizeInput(e.currentTarget.value);
                if (value === undefined) setFilled(sanitizedValue !== "");
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
                    };
                    onChange(event as any);
                }
            },
            [onChange, value]
        );

        const inputId = id || `input-${useId()}`;

        return (
            <div
                className={[
                    "gl-input",
                    focused ? "is-focused" : "",
                    isFilled ? "is-filled" : "",
                    containerClassName || "",
                ]
                    .filter(Boolean)
                    .join(" ")}
            >
                <input
                    id={inputId}
                    ref={ref}
                    type={type}
                    className={["gl-input__field", className || ""]
                        .filter(Boolean)
                        .join(" ")}
                    placeholder=" "
                    value={value as any}
                    defaultValue={defaultValue}
                    onFocus={handleFocus}
                    onBlur={handleBlur}
                    onChange={handleChange}
                    {...rest}
                />
                <label className="gl-input__label" htmlFor={inputId}>{title}</label>
            </div>
        );
    }
);

Input.displayName = "Input";
export default Input;