import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { nextRovingIndex, useClickOutside, useFloating, useStableId } from "@gl-admin/components/ui/a11y"
import { FieldMessage, describedBy } from "@gl-admin/components/ui/Input"
import { Listbox, optionId, type SelectOption } from "@gl-admin/components/ui/Select"
import { ChevronDownIcon } from "@gl-admin/components/ui/icons"
import "@gl-admin/assets/styles/components/ui/select.scss"

type ComboboxProps = {
  label: string
  options: SelectOption[]
  // The picked option's value, or null.
  value: string | null
  onChange: (value: string | null) => void
  placeholder?: string
  hint?: ReactNode
  error?: ReactNode
  // Shown when the typed text matches nothing.
  emptyMessage?: ReactNode
  // Defaults to a case-insensitive "contains" on the label.
  filter?: (option: SelectOption, query: string) => boolean
  disabled?: boolean
  id?: string
  className?: string
}

const contains = (option: SelectOption, query: string) => option.label.toLowerCase().includes(query.trim().toLowerCase())

// A text field that filters a list as you type (authors, categories, a parent page).
// Focus stays in the input: ArrowDown/ArrowUp open and move, Enter picks, Escape
// closes the list (a second Escape clears the text).
export default function Combobox({
  label,
  options,
  value,
  onChange,
  placeholder,
  hint,
  error,
  emptyMessage = "No matches",
  filter = contains,
  disabled = false,
  id,
  className = "",
}: ComboboxProps) {
  const fieldId = useStableId("combobox", id)
  const listId = `${fieldId}-list`
  const selected = options.find((o) => o.value === value) ?? null
  const [query, setQuery] = useState<string | null>(null) // null: showing the selection
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { style } = useFloating(wrapRef, listRef, open, "bottom-start", { matchWidth: true })

  const shown = useMemo(() => (query ? options.filter((o) => filter(o, query)) : options), [options, query, filter])
  const text = query ?? selected?.label ?? ""

  const close = () => {
    setOpen(false)
    setQuery(null)
  }
  useClickOutside([wrapRef, listRef], open, close)

  const pick = (opt: SelectOption) => {
    if (opt.disabled) return
    onChange(opt.value)
    close()
    inputRef.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault()
        e.stopPropagation()
        close()
      } else if (text) {
        e.preventDefault()
        e.stopPropagation()
        onChange(null)
        setQuery(null)
      }
      return
    }
    if (e.key === "Enter") {
      if (open && shown[active]) {
        e.preventDefault()
        pick(shown[active])
      }
      return
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        const at = shown.findIndex((o) => o.value === value)
        setActive(at >= 0 ? at : e.key === "ArrowUp" ? shown.length - 1 : 0)
        return
      }
      const next = nextRovingIndex(e.key, active, shown.length, "vertical")
      if (next !== null) setActive(next)
    }
  }

  return (
    <div className={`gl-field gl-combobox ${className}`}>
      <label className="gl-field__label" htmlFor={fieldId}>
        {label}
      </label>
      <div ref={wrapRef} className="gl-combobox__control">
        <input
          ref={inputRef}
          id={fieldId}
          type="text"
          role="combobox"
          className="gl-input__field gl-combobox__input"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && shown[active] ? optionId(listId, active) : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fieldId, hint, error)}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
            setActive(e.target.value ? 0 : -1)
          }}
          onKeyDown={onKeyDown}
          onBlur={(e) => {
            if (!listRef.current?.contains(e.relatedTarget as Node)) close()
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className="gl-combobox__toggle"
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            inputRef.current?.focus()
            if (open) close()
            else setOpen(true)
          }}
        >
          <ChevronDownIcon className="gl-select__chevron" />
        </button>
      </div>
      {open && (
        <Listbox
          ref={listRef}
          id={listId}
          label={label}
          options={shown}
          value={value}
          activeIndex={active}
          onPick={pick}
          onHover={setActive}
          style={style}
          empty={emptyMessage}
        />
      )}
      <FieldMessage id={fieldId} hint={hint} error={error} />
    </div>
  )
}
