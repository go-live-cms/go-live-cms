import IMask from "imask";

export type InputMaskType =
    | "number"
    | "text"
    | "email"
    | "password"
    | "date";

export type InputMasks = {
    number: {
        mask: RegExp;
        lazy: boolean;
    };
    text: {
        mask: RegExp;
        lazy: boolean;
    };
    email: {
        mask: RegExp;
        lazy: boolean;
    };
    password: {
        mask: RegExp;
        lazy: boolean;
    };
    date: {
        mask: typeof Date;
        pattern: string;
        blocks: {
            d: { mask: typeof IMask.MaskedRange; from: number; to: number; maxLength: number };
            m: { mask: typeof IMask.MaskedRange; from: number; to: number; maxLength: number };
            Y: { mask: typeof IMask.MaskedRange; from: number; to: number; maxLength: number };
        };
        format: (date: Date) => string;
        parse: (str: string) => Date;
        lazy: boolean;
    };
};

export const getInputMask = (type: InputMaskType) => {
    return inputMasks[type] || inputMasks.text;
};

export const inputMasks: InputMasks = {
    number: {
        mask: /^[0-9]*$/,
        lazy: false,
    },
    text: {
        mask: /^[\w\sÀ-ÿ.,'-]*$/,
        lazy: false,
    },
    email: {
        mask: /^\S+@\S+\.\S+$/,
        lazy: false,
    },
    password: {
        mask: /^[\S]{0,32}$/,
        lazy: false,
    },
    date: {
        mask: Date,
        pattern: 'd/`m/`Y',
        blocks: {
            d: { mask: IMask.MaskedRange, from: 1, to: 31, maxLength: 2 },
            m: { mask: IMask.MaskedRange, from: 1, to: 12, maxLength: 2 },
            Y: { mask: IMask.MaskedRange, from: 1900, to: 2099, maxLength: 4 },
        },
        format: (date: Date) => {
            const day = date.getDate();
            const month = date.getMonth() + 1;
            const year = date.getFullYear();
            return [day, month, year].join('/');
        },
        parse: (str: string) => {
            const [day, month, year] = str.split('/').map(Number);
            return new Date(year, month - 1, day);
        },
        lazy: false,
    },
    // Add more masks as needed
};

export default getInputMask;