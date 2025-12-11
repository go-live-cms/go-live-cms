import { useEffect, useState, useCallback } from "react"
import { BubbleMenu as TipTapBubbleMenu } from "@tiptap/react/menus"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { applyTurnInto, computeTurnIntoFromSelection, type TurnIntoValue } from "../utils/turnInto"
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

// Alignment icons as inline SVGs
const AlignLeftIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="15" y2="12" />
    <line x1="3" y1="18" x2="18" y2="18" />
  </svg>
)

const AlignCenterIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="6" y1="12" x2="18" y2="12" />
    <line x1="4" y1="18" x2="20" y2="18" />
  </svg>
)

const AlignRightIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="9" y1="12" x2="21" y2="12" />
    <line x1="6" y1="18" x2="21" y2="18" />
  </svg>
)

interface BlockTypeToolbarProps {
  editor: TiptapEditor
}

/**
 * WordPress-style block type toolbar
 * Appears when cursor is in a paragraph or heading block (no selection required)
 * Allows quick block type changes via dropdown and text alignment
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

  const alignButtonClasses =
    "hover:bg-gray-700 w-7 h-7 flex items-center justify-center rounded-md cursor-pointer transition-colors"

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

      {/* Text alignment buttons */}
      <div className="ml-2 flex items-center gap-0.5 border-l border-gray-600 pl-2">
        <button
          type="button"
          onClick={() => editor.chain().focus().setTextAlign("left").run()}
          className={`${alignButtonClasses} ${editor.isActive({ textAlign: "left" }) || (!editor.isActive({ textAlign: "center" }) && !editor.isActive({ textAlign: "right" })) ? "bg-gray-600" : "bg-transparent"}`}
          title="Align left"
        >
          <AlignLeftIcon />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().setTextAlign("center").run()}
          className={`${alignButtonClasses} ${editor.isActive({ textAlign: "center" }) ? "bg-gray-600" : "bg-transparent"}`}
          title="Align center"
        >
          <AlignCenterIcon />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().setTextAlign("right").run()}
          className={`${alignButtonClasses} ${editor.isActive({ textAlign: "right" }) ? "bg-gray-600" : "bg-transparent"}`}
          title="Align right"
        >
          <AlignRightIcon />
        </button>
      </div>
    </TipTapBubbleMenu>
  )
}

export default BlockTypeToolbar
