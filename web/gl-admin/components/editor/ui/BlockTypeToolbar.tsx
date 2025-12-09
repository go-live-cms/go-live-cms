import { useEffect, useState, useCallback } from "react"
import { BubbleMenu as TipTapBubbleMenu } from "@tiptap/react/menus"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { applyTurnInto, computeTurnIntoFromSelection, type TurnIntoValue } from "../utils/TurnInto"
import CommandSelect, { type CommandSelectOption } from "./CommandSelect"

/**
 * Block type options for WordPress-style dropdown
 * Shows Paragraph and H1-H6
 */
const blockTypeOptions: CommandSelectOption[] = [
  { value: "paragraph", label: "Paragraph", label_icon: "¶" },
  { value: "heading-1", label: "Heading 1", label_icon: "H1" },
  { value: "heading-2", label: "Heading 2", label_icon: "H2" },
  { value: "heading-3", label: "Heading 3", label_icon: "H3" },
  { value: "heading-4", label: "Heading 4", label_icon: "H4" },
  { value: "heading-5", label: "Heading 5", label_icon: "H5" },
  { value: "heading-6", label: "Heading 6", label_icon: "H6" },
]

interface BlockTypeToolbarProps {
  editor: TiptapEditor
}

/**
 * WordPress-style block type toolbar
 * Appears when cursor is in a paragraph or heading block (no selection required)
 * Allows quick block type changes via dropdown
 */
const BlockTypeToolbar = ({ editor }: BlockTypeToolbarProps) => {
  const [blockType, setBlockType] = useState<TurnIntoValue>("paragraph")

  const updateBlockType = useCallback(() => {
    if (!editor) return
    const v = computeTurnIntoFromSelection(editor)
    setBlockType(v)
  }, [editor])

  useEffect(() => {
    if (!editor) return
    updateBlockType()
    editor.on("selectionUpdate", updateBlockType)
    editor.on("transaction", updateBlockType)
    return () => {
      editor.off("selectionUpdate", updateBlockType)
      editor.off("transaction", updateBlockType)
    }
  }, [editor, updateBlockType])

  if (!editor) return null

  return (
    <TipTapBubbleMenu
      editor={editor}
      pluginKey="blockTypeToolbar"
      className="block-type-toolbar"
      shouldShow={({ editor, state }) => {
        // Don't show if there's a text selection (let BubbleMenu handle that)
        const { from, to } = state.selection
        if (from !== to) return false

        // Show only for paragraph and heading blocks
        const isInParagraph = editor.isActive("paragraph")
        const isInHeading = editor.isActive("heading")

        return isInParagraph || isInHeading
      }}
    >
      <CommandSelect
        options={blockTypeOptions}
        value={blockType}
        label=""
        onChange={(option: CommandSelectOption) => {
          if (!editor) return
          const val = option.value as TurnIntoValue
          setBlockType(val)
          applyTurnInto(editor, val, blockTypeOptions)
        }}
      />
    </TipTapBubbleMenu>
  )
}

export default BlockTypeToolbar
