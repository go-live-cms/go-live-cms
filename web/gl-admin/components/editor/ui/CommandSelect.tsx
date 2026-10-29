import React from "react"
import { CheckIcon, ChevronDownIcon } from "@gl-admin/components/ui/icons"
import { useSelect } from "@gl-admin/utils/select"

export type CommandSelectOption = {
    value: string
    label: string
    label_icon?: string
    command?: ({ editor, range }: any) => void
}

export type CommandSelectProps = {
    options: CommandSelectOption[]
    value: string
    onChange: (option: CommandSelectOption) => void
    label?: string
    disabled?: boolean
}

// The "Text ▾" picker in the editor's toolbars (#341: styled like the design's menus).
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

    const selected = options.find((opt) => opt.value === value)

    return (
        <div className="editor-select" ref={ref}>
            <button
                type="button"
                className="editor-select__trigger"
                // useSelect reads only the pointer position.
                onClick={(e) => handleSelectClick(e as unknown as React.MouseEvent<HTMLDivElement>)}
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={label ? `${label}: ${selected?.label ?? "none"}` : undefined}
            >
                {selected ? selected.label : "Select…"}
                <ChevronDownIcon size={12} />
            </button>
            {open && !disabled && (
                <div className="editor-select__list" role="listbox" aria-label={label || "Block type"} style={optionsStyle}>
                    {label && <span className="editor-select__label" aria-hidden="true">{label}</span>}
                    {options.map((opt) => (
                        <div
                            key={opt.value}
                            className="editor-select__option"
                            onClick={() => {
                                onChange(opt)
                                setOpen(false)
                            }}
                            onKeyDown={(e) => {
                                if (e.key !== "Enter" && e.key !== " ") return
                                e.preventDefault()
                                onChange(opt)
                                setOpen(false)
                            }}
                            tabIndex={0}
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
