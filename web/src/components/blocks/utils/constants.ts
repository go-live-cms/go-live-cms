/**
 * Shared constants for block configurations
 */

/** Text alignment options */
export const TEXT_ALIGN_OPTIONS = ["left", "center", "right", "justify"] as const
export type TextAlign = (typeof TEXT_ALIGN_OPTIONS)[number]

/** Heading levels */
export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const
export type HeadingLevel = (typeof HEADING_LEVELS)[number]

/** Block categories */
export const BLOCK_CATEGORIES = {
  TEXT: "text",
  MEDIA: "media",
  DESIGN: "design",
  WIDGETS: "widgets",
  EMBED: "embed",
  LAYOUT: "layout",
} as const
