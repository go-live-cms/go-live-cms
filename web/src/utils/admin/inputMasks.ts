export type InputMaskType =
    | "number"
    | "text"
    | "email"
    | "password";

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
        mask: /^[^\s]*$/,
        // mask: /^\S+@\S+\.\S+$/,
        lazy: false,
    },
    password: {
        mask: /^[\S]{0,32}$/,
        lazy: false,
    },
};

export const validationPatterns = {
    email: /^\S+@\S+\.\S+$/,
    password: /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/,
    text: /^[\w\sÀ-ÿ.,'-]*$/,
    number: /^[0-9]*$/
};

export const getValidationPattern = (type: InputMaskType) => {
    return validationPatterns[type] || validationPatterns.text;
};

export default getInputMask;