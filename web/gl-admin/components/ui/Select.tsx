import { forwardRef, useEffect, useRef, useState, type CSSProperties, type FC, type KeyboardEvent, type ReactNode } from "react"
import { nextRovingIndex, typeaheadIndex, useClickOutside, useFloating, useStableId } from "@gl-admin/components/ui/a11y"
import { FieldMessage, describedBy } from "@gl-admin/components/ui/Input"
import { CheckIcon, ChevronDownIcon } from "@gl-admin/components/ui/icons"
import "@gl-admin/assets/styles/components/ui/select.scss"

export type SelectOption = {
  value: string
  label: string
  // A second line in the list ("Can publish and edit anyone's posts").
  description?: string
  disabled?: boolean
}

type ListboxProps = {
  id: string
  options: SelectOption[]
  value: string | null
  activeIndex: number
  onPick: (option: SelectOption) => void
  onHover: (index: number) => void
  style: CSSProperties
  label?: string
  empty?: ReactNode
}

export const optionId = (listId: string, index: number) => `${listId}-opt-${index}`

// The floating list shared by Select, FilterSelect and Combobox. Focus stays on the
// trigger or input; the active option is announced through aria-activedescendant.
export const Listbox = forwardRef<HTMLDivElement, ListboxProps>(function Listbox(
  { id, options, value, activeIndex, onPick, onHover, style, label, empty },
  ref
) {
  // Keep the active option in view while arrowing through a long list.
  useEffect(() => {
    document.getElementById(optionId(id, activeIndex))?.scrollIntoView?.({ block: "nearest" })
  }, [id, activeIndex])

  return (
    <div ref={ref} id={id} role="listbox" aria-label={label} className="gl-listbox" style={style}>
      {options.length === 0 && <div className="gl-listbox__empty">{empty ?? "No options"}</div>}
      {options.map((opt, i) => (
        <div
          key={opt.value}
          id={optionId(id, i)}
          role="option"
          aria-selected={opt.value === value}
          aria-disabled={opt.disabled || undefined}
          data-active={i === activeIndex}
          className="gl-listbox__option"
          // Keep focus on the trigger/input when picking with the pointer.
          onMouseDown={(e) => e.preventDefault()}
          onMouseMove={() => i !== activeIndex && onHover(i)}
          onClick={() => !opt.disabled && onPick(opt)}
        >
          <span className="gl-listbox__text">
            <span className="gl-listbox__label">{opt.label}</span>
            {opt.description && <span className="gl-listbox__description">{opt.description}</span>}
          </span>
          {opt.value === value && <CheckIcon className="gl-listbox__check" />}
        </div>
      ))}
    </div>
  )
})

// Keyboard and open state of a select-only combobox (WAI-ARIA APG): arrows open the
// list and move through it, Home/End jump, a letter jumps to the next option starting
// with it, Enter/Space pick, Escape closes, Tab picks nothing and moves on.
export function useSelectListbox(options: SelectOption[], value: string, onChange: (v: string) => void, disabled = false) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const selectedIndex = options.findIndex((o) => o.value === value)

  useClickOutside([triggerRef, listRef], open, () => setOpen(false))

  const openAt = (index: number) => {
    if (disabled) return
    setActive(index)
    setOpen(true)
  }
  const pick = (opt: SelectOption) => {
    if (opt.disabled) return
    onChange(opt.value)
    setOpen(false)
    triggerRef.current?.focus()
  }
  // Moves to the next enabled option from `from` in `dir`.
  const enabledFrom = (from: number, dir: 1 | -1) => {
    for (let step = 0; step < options.length; step++) {
      const i = (from + dir * step + options.length) % options.length
      if (!options[i].disabled) return i
    }
    return -1
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (disabled) return
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault()
        openAt(selectedIndex >= 0 ? selectedIndex : enabledFrom(e.key === "ArrowUp" ? options.length - 1 : 0, e.key === "ArrowUp" ? -1 : 1))
      }
      return
    }
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      if (options[active]) pick(options[active])
    } else if (e.key === "Tab") {
      setOpen(false)
    } else {
      const next = nextRovingIndex(e.key, active, options.length, "vertical")
      if (next !== null) {
        e.preventDefault()
        const dir = e.key === "ArrowUp" || e.key === "End" ? -1 : 1
        setActive(enabledFrom(next, dir))
        return
      }
      // Disabled options get an empty label, so typeahead skips them as the arrows do.
      const jump = typeaheadIndex(options.map((o) => (o.disabled ? "" : o.label)), e.key, active)
      if (jump !== null) setActive(jump)
    }
  }

  return {
    open,
    active,
    setActive,
    triggerRef,
    listRef,
    toggle: () => (open ? setOpen(false) : openAt(selectedIndex >= 0 ? selectedIndex : enabledFrom(0, 1))),
    pick,
    onKeyDown,
  }
}

export type SelectProps = {
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
  label?: string
  disabled?: boolean
  // Shown while nothing is selected.
  placeholder?: string
  hint?: ReactNode
  error?: ReactNode
  id?: string
  // Names the control when there's no visible label.
  "aria-label"?: string
  // Pre-redesign; ignored, every Select is a bordered field now.
  bordered?: boolean
  className?: string
}

// A dropdown that picks one option from a short list (role, parent term, rows per
// page). For long or searchable lists, use Combobox.
export const Select: FC<SelectProps> = ({
  options,
  value,
  onChange,
  label,
  disabled = false,
  placeholder = "Select…",
  hint,
  error,
  id,
  className = "",
  ...aria
}) => {
  const fieldId = useStableId("select", id)
  const listId = `${fieldId}-list`
  const lb = useSelectListbox(options, value, onChange, disabled)
  const { style } = useFloating(lb.triggerRef, lb.listRef, lb.open, "bottom-start", { matchWidth: true })
  const selected = options.find((opt) => opt.value === value)

  return (
    <div className={`gl-field gl-select ${className}`}>
      {label && (
        <label className="gl-field__label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      <button
        ref={lb.triggerRef}
        id={fieldId}
        type="button"
        role="combobox"
        className="gl-select__trigger"
        aria-haspopup="listbox"
        aria-expanded={lb.open}
        aria-controls={lb.open ? listId : undefined}
        aria-activedescendant={lb.open && lb.active >= 0 ? optionId(listId, lb.active) : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, hint, error)}
        aria-label={label ? undefined : aria["aria-label"]}
        disabled={disabled}
        onClick={lb.toggle}
        onKeyDown={lb.onKeyDown}
      >
        <span className={`gl-select__value${selected ? "" : " is-placeholder"}`}>{selected ? selected.label : placeholder}</span>
        <ChevronDownIcon className="gl-select__chevron" />
      </button>
      {lb.open && (
        <Listbox
          ref={lb.listRef}
          id={listId}
          label={label ?? aria["aria-label"]}
          options={options}
          value={value}
          activeIndex={lb.active}
          onPick={lb.pick}
          onHover={lb.setActive}
          style={style}
        />
      )}
      <FieldMessage id={fieldId} hint={hint} error={error} />
    </div>
  )
}

export default Select
