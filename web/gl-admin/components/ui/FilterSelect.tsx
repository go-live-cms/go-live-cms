import React from "react";
import { useGoLive } from "@gl-admin/contexts/GoLiveContext";
import { useSelect } from "@gl-admin/utils/select";
import Icon from "@gl-admin/components/ui/Icon";
import "@gl-admin/assets/styles/components/ui/filter-select.scss";

type Option = {
    label: string;
    value: string;
};

interface FilterSelectProps {
    options: Option[];
    value: string;
    onChange: (value: string) => void;
    prefix?: string;
    disabled?: boolean;
    loading?: boolean;
}

const FilterSelect: React.FC<FilterSelectProps> = ({
    options,
    value,
    onChange,
    prefix,
    disabled = false,
    loading = false,
}) => {
    const {
        open,
        setOpen,
        optionsStyle,
        ref,
        handleSelectClick,
    } = useSelect(disabled);
    const { isDark } = useGoLive();
    const iconColor = isDark ? "#FFFFFF" : "#333536";
    const selectedOption = options.find(opt => opt.value === value);

    if (loading) {
        return <div className="gl-filter-select skeleton" />;
    }

    return (
        <div className="gl-filter-select" ref={ref}>
            <div
                className={`gl-filter-select__control${disabled ? " disabled" : ""}`}
                onClick={handleSelectClick}
                tabIndex={0}
                role="button"
                aria-disabled={disabled}
            >
                {prefix && <span className="gl-filter-select__prefix">{prefix}</span>}
                <span className="gl-filter-select__value">
                    {selectedOption ? selectedOption.label : "Select..."}
                </span>
                <Icon name="dropdown" mirror_vertically={open} color={iconColor} width="7px" height="4.3px" />
            </div>
            {open && (
                <div className="gl-filter-select__options" style={optionsStyle}>
                    {options.map(opt => (
                        <div
                            key={opt.value}
                            className={`gl-filter-select__option${opt.value === value ? " selected" : ""}`}
                            onClick={() => {
                                onChange(opt.value);
                                setOpen(false);
                            }}
                            tabIndex={0}
                            role="option"
                            aria-selected={opt.value === value}
                        >
                            {opt.label}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default FilterSelect;

