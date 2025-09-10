import type { SlashCommandItem } from "./SlashCommand"
import type { CommandSelectOption } from "./ui/CommandSelect"
import type { Editor } from "@tiptap/core"

export type Command = {
    title: string,
    icon: string,
    description: string,
    aliases: string[],
    slash: boolean,
    turnInto: boolean,
    command: ({ editor }: any) => void
}

export const commands: Command[] = [
    {
      title: "Paragraph",
      icon: " T ",
      description: "Regular text",
      aliases: ["paragraph", "p"],
      slash: true,
      turnInto: true,
      command: ({ editor }) => {
        editor.chain().focus().setParagraph().run()
      },
    },
    {
      title: "Heading 1",
      icon: "📝",
      description: "Section heading",
      aliases: ["h1", "heading1"],
      slash: true,
      turnInto: true,
      command: ({ editor }) => {
        editor.chain().focus().setHeading({ level: 1 }).run()
      },
    },
    {
      title: "Heading 2",
      icon: "📝",
      description: "Section heading",
      aliases: ["h2", "heading2"],
      slash: true,
      turnInto: true,
      command: ({ editor }) => {
        editor.chain().focus().setHeading({ level: 2 }).run()
      },
    },
    {
      title: "Heading 3",
      icon: "📝",
      description: "Section heading",
      aliases: ["h3", "heading3"],
      slash: true,
      turnInto: true,
      command: ({ editor }) => {
        editor.chain().focus().setHeading({ level: 3 }).run()
      },
    },
    {
      title: "Bullet List",
      icon: "•",
      description: "Create a simple bullet list",
      aliases: ["ul", "list"],
      slash: true,
      turnInto: true,
      command: ({ editor }) => {
        editor.chain().focus().toggleBulletList().run()
      },
    },
    {
      title: "Numbered List",
      icon: "1.",
      description: "Create a numbered list",
      aliases: ["ol", "ordered"],
      slash: true,
      turnInto: true,
      command: ({ editor }) => {
        editor.chain().focus().toggleOrderedList().run()
      },
    },
    {
      title: "Quote",
      icon: "💬",
      description: "Add a blockquote",
      aliases: ["quote", "blockquote"],
      slash: true,
      turnInto: true,
      command: ({ editor }) => {
        editor.chain().focus().setBlockquote().run()
      },
    },
    {
      title: "Code Block",
      icon: "💻",
      description: "Add a code block with syntax highlighting",
      aliases: ["code", "codeblock"],
      slash: true,
      turnInto: true,
      command: ({ editor }) => {
        editor.chain().focus().setCodeBlock().run()
      },
    },
    {
      title: "Divider",
      icon: "➖",
      description: "Add a horizontal divider",
      aliases: ["hr", "divider", "separator"],
      slash: true,
      turnInto: true,
      command: ({ editor }) => {
        editor.chain().focus().setHorizontalRule().run()
      },
    },
    {
      title: "Image",
      icon: "🖼️",
      description: "Add an image",
      slash: true,
      turnInto: true,
      aliases: ["img", "image", "picture"],
      command: ({ editor }) => {
        const url = window.prompt("Image URL")
        if (url) {
          editor.chain().focus().setImage({ src: url }).run()
        }
      },
    },
]

export const getSlashCommands: (editor: Editor) => SlashCommandItem[] = (editor) => {
    return commands
        .filter(cmd => cmd.slash)
        .map(cmd => ({
            title: cmd.title,
            icon: cmd.icon,
            description: cmd.description,
            aliases: cmd.aliases,
            command: cmd.command
        }));
}

export const getTurnIntoCommandOptions: (editor: Editor) => CommandSelectOption[] = (editor) => {
    return commands
        .filter(cmd => cmd.turnInto)
        .map(cmd => ({
            label: cmd.title,
            labelIcon: cmd.icon,
            value: cmd.title.toLowerCase().replace(/\s+/g, '-'),
            command: cmd.command
        }));
}