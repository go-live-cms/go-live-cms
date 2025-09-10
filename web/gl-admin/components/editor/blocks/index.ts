import type { SlashCommandItem } from "../SlashCommand"
import type { CommandSelectOption } from "@gl-admin/components/editor/ui/CommandSelect"
import { headingBlocks } from "./headingBlocks"
import { listBlocks } from "./listBlocks"
import { textBlocks } from "./textBlocks"
import { createMediaBlocks } from "./mediaBlocks"

export type Block = {
  title: string
  icon: string
  description: string
  aliases: string[]
  command: ({ editor, range }: any) => void
  turnInto?: ({ editor }: any) => void
}

export const getAllBlocks = (): Block[] => {
  return [...headingBlocks, ...listBlocks, ...textBlocks, ...createMediaBlocks()]
}

export const getSlashCommandItems = (): SlashCommandItem[] => {
  return getAllBlocks()
    .filter((cmd) => cmd.command)
    .map((cmd) => ({
      title: cmd.title,
      icon: cmd.icon,
      description: cmd.description,
      aliases: cmd.aliases,
      command: cmd.command,
    }))
}

export const getTurnIntoCommandOptions = (): CommandSelectOption[] => {
  return getAllBlocks()
    .filter((cmd) => cmd.turnInto)
    .map((cmd) => ({
      label: cmd.title,
      label_icon: cmd.icon,
      value: cmd.title.toLowerCase().replace(/\s+/g, "-"),
      command: cmd.turnInto,
    }))
}

// Export individual block groups for potential future use
export { headingBlocks, listBlocks, textBlocks, createMediaBlocks }
