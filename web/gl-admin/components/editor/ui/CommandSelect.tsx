import React from "react"
import Icon from "@gl-admin/components/ui/Icon"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
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
    const { isDark } = useGoLive()
    const iconColor = isDark ? "#FFFFFF" : "#333536"

    return (
        <div className="text-white relative hover:bg-gray-700/60 rounded-md select-none text-sm flex items-center cursor-pointer" ref={ref} style={{ position: "relative" }}>
            <div
                className={`flex items-center gap-1.5 py-1 px-2 ${disabled ? "text-gray-300" : ""}`}
                onClick={handleSelectClick}
                tabIndex={0}
                role="button"
                aria-disabled={disabled}
            >
                <span className="text-gray-200">
                    {selected ? selected.label : "Select..."}
                </span>
                <Icon className="mt-[1px]" name="dropdown" mirror_vertically={open} color={iconColor} width="12px" height="6.3px" />
            </div>
            {open && !disabled && (
                <div
                    className="absolute p-2 py-2 mt-1 bg-gray-800 select-none border border-gray-700 shadow rounded-sm text-sm"
                    style={optionsStyle}
                >
                    <label className="p-1 pb-2 text-gray-400 block">{label}</label>
                    {options.map((opt) => (
                        <div
                            key={opt.value}
                            className="hover:bg-gray-700 rounded-sm min-w-[180px] p-1 flex gap-1 items-center text-nowrap"
                            onClick={() => {
                                onChange(opt)
                                setOpen(false)
                            }}
                            tabIndex={0}
                            role="option"
                            aria-selected={opt.value === value}
                        >
                            {opt.label_icon && <span className="text-md w-4 flex items-center justify-center">{opt.label_icon}</span>}
                            {opt.label}
                            {opt.value === value && <span className="ml-auto text-gray-400">✔️</span>}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

export default CommandSelect