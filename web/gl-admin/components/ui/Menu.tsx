import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react"
import type { Placement } from "@floating-ui/dom"
import {
  nextRovingIndex,
  typeaheadIndex,
  useClickOutside,
  useEscape,
  useFloating,
  useStableId,
} from "@gl-admin/components/ui/a11y"
import "@gl-admin/assets/styles/components/ui/menu.scss"

// The props Menu and Popover hand their trigger: spread them on a Button or IconButton.
export type TriggerProps = {
  ref: Ref<HTMLButtonElement>
  onClick: () => void
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
  "aria-haspopup": "menu" | "dialog"
  "aria-expanded": boolean
  "aria-controls": string | undefined
}

const MenuContext = createContext<{ close: (refocus: boolean) => void } | null>(null)

type MenuProps = {
  trigger: (props: TriggerProps) => ReactElement
  // Names the menu ("Post actions").
  label: string
  children: ReactNode
  placement?: Placement
  className?: string
}

const ITEM = "[role='menuitem']:not([aria-disabled='true'])"

// A menu of actions (#144): Enter, Space or ArrowDown on the trigger opens it on the first
// item (ArrowUp: the last); arrows, Home and End move, a letter jumps to the next item
// starting with it; Enter/Space runs the item; Escape closes and returns focus to the
// trigger, Tab closes and moves on.
export default function Menu({ trigger, label, children, placement = "bottom-start", className = "" }: MenuProps) {
  const [open, setOpen] = useState(false)
  const [initial, setInitial] = useState<"first" | "last">("first")
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useStableId("menu")
  const { style, ready } = useFloating(triggerRef, menuRef, open, placement)

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }, [])

  useEscape(open, () => close(true))
  useClickOutside([triggerRef, menuRef], open, () => close(false))

  // Focus the first (or last) item once the menu is positioned (and so visible).
  useEffect(() => {
    if (!open || !ready) return
    const list = items()
    ;(initial === "first" ? list[0] : list[list.length - 1])?.focus()
  }, [open, ready, initial])

  const openWith = (which: "first" | "last") => {
    setInitial(which)
    setOpen(true)
  }

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Enter and Space reach onClick as a click, which opens on the first item too.
    if (e.key === "ArrowDown") {
      e.preventDefault()
      openWith("first")
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      openWith("last")
    }
  }

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items()
    const current = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === "Tab") {
      close(false)
      return
    }
    const next =
      nextRovingIndex(e.key, current, list.length, "vertical") ??
      (e.ctrlKey || e.metaKey || e.altKey ? null : typeaheadIndex(list.map((el) => el.textContent ?? ""), e.key, current))
    if (next === null) return
    e.preventDefault()
    list[next]?.focus()
  }

  return (
    <MenuContext.Provider value={{ close }}>
      {trigger({
        ref: triggerRef,
        onClick: () => (open ? close(false) : openWith("first")),
        onKeyDown: onTriggerKeyDown,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": open ? menuId : undefined,
      })}
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className={`gl-menu ${className}`}
          style={style}
          onKeyDown={onMenuKeyDown}
        >
          {children}
        </div>
      )}
    </MenuContext.Provider>
  )
}

type MenuItemProps = {
  children: ReactNode
  onSelect: () => void
  // A second line in text-secondary that names the consequence.
  description?: ReactNode
  // Destructive: drawn in danger-text.
  danger?: boolean
  disabled?: boolean
  // 16px decorative icon before the label.
  icon?: ReactNode
}

export function MenuItem({ children, onSelect, description, danger = false, disabled = false, icon }: MenuItemProps) {
  const menu = useContext(MenuContext)

  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      className={`gl-menu__item${danger ? " gl-menu__item--danger" : ""}${description ? " gl-menu__item--described" : ""}`}
      // Pointer and keyboard share one highlight: hovering an item focuses it.
      onMouseMove={(e) => {
        if (!disabled && document.activeElement !== e.currentTarget) e.currentTarget.focus()
      }}
      onClick={() => {
        if (disabled) return
        menu?.close(true)
        onSelect()
      }}
    >
      {icon && (
        <span className="gl-menu__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="gl-menu__text">
        <span className="gl-menu__label">{children}</span>
        {description && <span className="gl-menu__description">{description}</span>}
      </span>
    </button>
  )
}

export function MenuSeparator() {
  return <div role="separator" className="gl-menu__separator" />
}
