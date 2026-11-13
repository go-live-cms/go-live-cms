import React, { useEffect, useRef, useState } from "react"
import { CheckIcon, ChevronDownIcon } from "@gl-admin/components/ui/icons"
import { nextRovingIndex, typeaheadIndex, useStableId } from "@gl-admin/components/ui/a11y"
import { useSelect } from "@gl-admin/utils/select"

export type CommandSelectOption = {
    value: string
    label: string
    // A glyph or an icon (catalog entries: BlockIcon), decorative.
    label_icon?: React.ReactNode
}

export type CommandSelectProps = {
    options: CommandSelectOption[]
    value: string
    onChange: (option: CommandSelectOption) => void
    label?: string
    disabled?: boolean
}

// The "Text ▾" picker in the editor's toolbars (#341: styled like the design's menus).
// Keyboard (#144): ↓/↑ on the trigger opens the list with focus on the current option;
// in the list ↑↓ Home End and typeahead move, ↵ or Space picks, Esc closes it and
// gives focus back to the trigger, Tab closes it.
export const CommandSelect: React.FC<CommandSelectProps> = ({
    options,
    value,
    onChange,
    label,
    disabled = false,
}) => {
    const {
        open,
        setOpen,
        optionsStyle,
        ref,
        handleSelectClick,
    } = useSelect(disabled)
    const listId = useStableId("gl-command-select")
    const trigger = useRef<HTMLButtonElement>(null)
    const list = useRef<HTMLDivElement>(null)
    const selectedIndex = Math.max(0, options.findIndex((opt) => opt.value === value))
    const [active, setActive] = useState(selectedIndex)

    const selected = options.find((opt) => opt.value === value)

    // Focus follows the active option while the list is open.
    useEffect(() => {
        if (!open) return
        list.current?.querySelectorAll<HTMLElement>('[role="option"]')[active]?.focus()
    }, [open, active])

    const openList = () => {
        setActive(selectedIndex)
        setOpen(true)
    }

    const close = (refocus: boolean) => {
        setOpen(false)
        if (refocus) trigger.current?.focus()
    }

    const pick = (opt: CommandSelectOption) => {
        onChange(opt)
        setOpen(false)
    }

    const onTriggerKeyDown = (e: React.KeyboardEvent) => {
        if (disabled || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return
        e.preventDefault()
        openList()
    }

    const onListKeyDown = (e: React.KeyboardEvent) => {
        const next = nextRovingIndex(e.key, active, options.length)
        if (next !== null) {
            e.preventDefault()
            setActive(next)
            return
        }
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            const opt = options[active]
            if (opt) pick(opt)
        } else if (e.key === "Escape") {
            // Only the list closes: not a dialog or toolbar around it.
            e.preventDefault()
            e.stopPropagation()
            close(true)
        } else if (e.key === "Tab") {
            setOpen(false)
        } else {
            const i = typeaheadIndex(options.map((o) => o.label), e.key, active)
            if (i !== null) setActive(i)
        }
    }

    return (
        <div className="editor-select" ref={ref}>
            <button
                ref={trigger}
                type="button"
                className="editor-select__trigger"
                // useSelect reads only the pointer position.
                onClick={(e) => {
                    if (!open) setActive(selectedIndex)
                    handleSelectClick(e as unknown as React.MouseEvent<HTMLDivElement>)
                }}
                onKeyDown={onTriggerKeyDown}
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                aria-label={label ? `${label}: ${selected?.label ?? "none"}` : undefined}
            >
                {selected ? selected.label : "Select…"}
                <ChevronDownIcon size={12} />
            </button>
            {open && !disabled && (
                <div
                    ref={list}
                    id={listId}
                    className="editor-select__list"
                    role="listbox"
                    aria-label={label || "Block type"}
                    style={optionsStyle}
                    onKeyDown={onListKeyDown}
                >
                    {label && <span className="editor-select__label" aria-hidden="true">{label}</span>}
                    {options.map((opt, i) => (
                        <div
                            key={opt.value}
                            className="editor-select__option"
                            onClick={() => pick(opt)}
                            tabIndex={i === active ? 0 : -1}
                            role="option"
                            aria-selected={opt.value === value}
                        >
                            {opt.label_icon && <span className="editor-select__glyph" aria-hidden="true">{opt.label_icon}</span>}
                            {opt.label}
                            {opt.value === value && (
                                <span className="editor-select__check" aria-hidden="true">
                                    <CheckIcon size={14} />
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

export default CommandSelect
