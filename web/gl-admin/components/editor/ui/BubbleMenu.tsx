import { useEffect, useState, useCallback } from "react"
import { BubbleMenu as TipTapBubbleMenu } from "@tiptap/react/menus"
import { getTurnIntoCommandOptions } from "../blocks"
import { applyTurnInto, computeTurnIntoFromSelection, type TurnIntoValue } from "../utils/TurnInto"
import CommandSelect, { type CommandSelectOption } from "../ui/CommandSelect"

const BubbleMenu = ({ editor, className, ...props }: any) => {
    const [turnIntoOptions, setTurnIntoOptions] = useState<CommandSelectOption[]>([])
    const [turnInto, setTurnInto] = useState<TurnIntoValue>("paragraph")
    const bubbleMenuItemClasses = "hover:bg-gray-700/80 w-7 h-7 flex items-center justify-center rounded-sm py-1 px-2 cursor-pointer";

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
        <TipTapBubbleMenu editor={editor} className={`bg-gray-800/80 backdrop-blur-xs select-none shadow rounded-lg text-sm flex gap-2 py-1 px-2 border mb-2 border-gray-700 ${className}`} {...props}>
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
                className={`${bubbleMenuItemClasses} ${editor.isActive("bold") ? "text-blue-500 font-semibold" : "text-gray-200"}`}
                type="button"
            >
                <strong>B</strong>
            </button>
            <button
                onClick={() => editor.chain().focus().toggleItalic().run()}
                className={`${bubbleMenuItemClasses} ${editor.isActive("italic") ? "text-blue-500 font-semibold" : "text-gray-200"}`}
                type="button"
            >
                <em>I</em>
            </button>
            <button
                onClick={() => editor.chain().focus().toggleUnderline().run()}
                className={`${bubbleMenuItemClasses} ${editor.isActive("underline") ? "text-blue-500 font-semibold" : "text-gray-200"}`}
                type="button"
            >
                <u>U</u>
            </button>
            <button
                onClick={() => editor.chain().focus().toggleStrike().run()}
                className={`${bubbleMenuItemClasses} ${editor.isActive("strike") ? "text-blue-500 font-semibold" : "text-gray-200"}`}
                type="button"
            >
                <s>S</s>
            </button>
            <button
                onClick={() => editor.chain().focus().toggleCode().run()}
                className={`${bubbleMenuItemClasses} ${editor.isActive("code") ? "text-blue-500 font-semibold" : "text-gray-200"}`}
                type="button"
            >
                <span className="font-mono text-xs">{'</>'}</span>
            </button>
            <button
                onClick={() => {
                    const url = window.prompt("URL")
                    if (url) editor.chain().focus().setLink({ href: url }).run()
                }}
                className={`${bubbleMenuItemClasses} ${editor.isActive("link") ? "text-blue-500 font-semibold" : "text-gray-200"}`}
                type="button"
            >
                🔗
            </button>
        </TipTapBubbleMenu>
    )
}

export default BubbleMenu