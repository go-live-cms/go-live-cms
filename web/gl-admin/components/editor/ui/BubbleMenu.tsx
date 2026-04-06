import { useEffect, useState, useCallback } from "react"
import { BubbleMenu as TipTapBubbleMenu } from "@tiptap/react/menus"
import { getTurnIntoCommandOptions } from "../blocks"
import { applyTurnInto, computeTurnIntoFromSelection, type TurnIntoValue } from "../utils/turnInto"
import CommandSelect, { type CommandSelectOption } from "../ui/CommandSelect"

/** Safely check if editor view is mounted (TipTap v3 throws on .view access) */
function isViewMounted(editor: any): boolean {
  try {
    return !!editor?.view?.dom?.parentElement
  } catch {
    return false
  }
}

const BubbleMenu = ({ editor, className, openLinkModal, ...props }: any) => {
  const [turnIntoOptions, setTurnIntoOptions] = useState<CommandSelectOption[]>([])
  const [turnInto, setTurnInto] = useState<TurnIntoValue>("paragraph")
  const bubbleMenuItemClasses =
    "hover:bg-gray-700/80 w-7 h-7 flex items-center justify-center rounded-sm py-1 px-2 cursor-pointer"

  useEffect(() => {
    if (!editor) return
    setTurnIntoOptions(getTurnIntoCommandOptions())
    setTurnInto(computeTurnIntoFromSelection(editor))
  }, [editor])

  const updateTurnInto = useCallback(() => {
    if (!editor) return
    const v = computeTurnIntoFromSelection(editor)
    setTurnInto(v)
  }, [editor])

  useEffect(() => {
    if (!editor) return
    editor.on("selectionUpdate", updateTurnInto)
    editor.on("transaction", updateTurnInto)
    return () => {
      editor.off("selectionUpdate", updateTurnInto)
      editor.off("transaction", updateTurnInto)
    }
  }, [editor, updateTurnInto])

  if (!editor) return null

  return (
    <TipTapBubbleMenu
      editor={editor}
      className={`mb-2 flex gap-2 rounded-lg border border-gray-700 bg-gray-800/80 px-2 py-1 text-sm shadow backdrop-blur-xs select-none ${className}`}
      shouldShow={({ editor: e }) => {
        // Prevent positioning when view is not fully mounted (avoids domFromPos null error)
        if (!isViewMounted(e)) return false
        // Default: show when there's a text selection
        const { from, to } = e.state.selection
        return from !== to
      }}
      {...props}
    >
      <CommandSelect
        options={turnIntoOptions}
        value={turnInto}
        label="Turn into"
        onChange={(option: CommandSelectOption) => {
          if (!editor) return
          const val = option.value as TurnIntoValue
          setTurnInto(val)
          applyTurnInto(editor, val, turnIntoOptions)
        }}
      />
      <button
        onClick={() => editor.chain().focus().toggleBold().run()}
        className={`${bubbleMenuItemClasses} ${editor.isActive("bold") ? "font-semibold text-blue-500" : "text-gray-200"}`}
        type="button"
      >
        <strong>B</strong>
      </button>
      <button
        onClick={() => editor.chain().focus().toggleItalic().run()}
        className={`${bubbleMenuItemClasses} ${editor.isActive("italic") ? "font-semibold text-blue-500" : "text-gray-200"}`}
        type="button"
      >
        <em>I</em>
      </button>
      <button
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        className={`${bubbleMenuItemClasses} ${editor.isActive("underline") ? "font-semibold text-blue-500" : "text-gray-200"}`}
        type="button"
      >
        <u>U</u>
      </button>
      <button
        onClick={() => editor.chain().focus().toggleStrike().run()}
        className={`${bubbleMenuItemClasses} ${editor.isActive("strike") ? "font-semibold text-blue-500" : "text-gray-200"}`}
        type="button"
      >
        <s>S</s>
      </button>
      <button
        onClick={() => editor.chain().focus().toggleCode().run()}
        className={`${bubbleMenuItemClasses} ${editor.isActive("code") ? "font-semibold text-blue-500" : "text-gray-200"}`}
        type="button"
      >
        <span className="font-mono text-xs">{"</>"}</span>
      </button>
      <button
        onClick={openLinkModal}
        className={`${bubbleMenuItemClasses} ${editor.isActive("link") ? "font-semibold text-blue-500" : "text-gray-200"}`}
        type="button"
      >
        🔗
      </button>
    </TipTapBubbleMenu>
  )
}

export default BubbleMenu
