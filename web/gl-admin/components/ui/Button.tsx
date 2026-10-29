import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react"
import "@gl-admin/assets/styles/components/ui/button.scss"

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"
export type ButtonSize = "sm" | "md" | "lg"

// The variations from before the redesign (#338), mapped onto the new variants so
// existing screens keep working until #339–#344 move them to `variant`.
type LegacyVariation = "default" | "active" | "inactive" | "primary" | "secondary" | "flat" | "danger"
const LEGACY: Record<LegacyVariation, ButtonVariant> = {
  default: "primary",
  active: "primary",
  inactive: "secondary",
  primary: "primary",
  secondary: "secondary",
  flat: "secondary",
  danger: "danger",
}

type ButtonProps = {
  children: ReactNode
  // primary: the one main action on a screen. secondary: everything else. ghost: low
  // emphasis (toolbars, "Cancel" next to a primary). danger: confirms a destructive
  // action inside its dialog; in menus use a danger MenuItem instead.
  variant?: ButtonVariant
  // 28 / 32 / 36px tall. md is the default control height; lg is for forms and dialogs.
  size?: ButtonSize
  // Icon before the label, 16px, decorative.
  icon?: ReactNode
  // Shows a spinner, keeps the width, and blocks clicks.
  loading?: boolean
  // Pre-redesign name; new code uses `variant`.
  variation?: LegacyVariation
  as?: "button" | "a"
  href?: string // Only used when `as === 'a'`
  className?: string
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "type"> & {
    type?: "button" | "submit" | "reset"
  }

export function buttonClassName(variant: ButtonVariant, size: ButtonSize, extra = "") {
  return ["gl-button", `gl-button--${variant}`, `gl-button--${size}`, extra].filter(Boolean).join(" ")
}

const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(function Button(
  {
    children,
    variant,
    size = "md",
    icon,
    loading = false,
    variation,
    as = "button",
    href,
    type = "button",
    className = "",
    disabled,
    ...props
  },
  ref
) {
  const resolved = variant ?? LEGACY[variation ?? "default"]
  const classNames = buttonClassName(
    resolved,
    size,
    [loading ? "is-loading" : "", variation === "inactive" ? "is-inactive" : "", className].filter(Boolean).join(" ")
  )
  const content = (
    <>
      {loading ? <span className="gl-button__spinner" aria-hidden="true" /> : icon && <span className="gl-button__icon" aria-hidden="true">{icon}</span>}
      <span className="gl-button__label">{children}</span>
    </>
  )

  if (as === "a" && href) {
    return (
      <a
        ref={ref as Ref<HTMLAnchorElement>}
        href={href}
        className={classNames}
        {...(props as AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {content}
      </a>
    )
  }

  return (
    <button
      ref={ref as Ref<HTMLButtonElement>}
      type={type}
      className={classNames}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...(props as ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      {content}
    </button>
  )
})

export default Button

type IconButtonProps = {
  // Required: an icon-only button has no visible text, so this is its name.
  "aria-label": string
  icon: ReactNode
  variant?: Exclude<ButtonVariant, "primary">
  size?: ButtonSize
  type?: "button" | "submit" | "reset"
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children">

// A square button with only an icon (close, more actions, clear selection).
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, variant = "ghost", size = "md", type = "button", className = "", ...props },
  ref
) {
  return (
    <button ref={ref} type={type} className={buttonClassName(variant, size, `gl-button--icon-only ${className}`)} {...props}>
      <span className="gl-button__icon" aria-hidden="true">
        {icon}
      </span>
    </button>
  )
})
