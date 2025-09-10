import type { SlashCommandItem } from "../SlashCommand"
import { headingBlocks } from "./headingBlocks"
import { listBlocks } from "./listBlocks"
import { textBlocks } from "./textBlocks"
import { createMediaBlocks } from "./mediaBlocks"

export const getAllBlocks = (): SlashCommandItem[] => {
  return [...headingBlocks, ...listBlocks, ...textBlocks, ...createMediaBlocks()]
}

// Export individual block groups for potential future use
export { headingBlocks, listBlocks, textBlocks, createMediaBlocks }
