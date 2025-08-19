// Shouldn't include a file extension, and it exclusively represents files in assets/icons
export type IconPath = string;

export type IconGradient = string[] | undefined;

export interface Section {
    icon?: IconPath,
    name: string,
    link: string,
    sub?: Section[],
    gradient?: IconGradient,
    type?: "external",
    isActive?: boolean;
}

export type Navigation = Section[][];
