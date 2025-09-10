import { useEffect, useState, useCallback } from "react"
import { BubbleMenu as TipTapBubbleMenu } from "@tiptap/react/menus"
import { getTurnIntoCommandOptions } from "../blocks"
import { applyTurnInto, computeTurnIntoFromSelection, type TurnIntoValue } from "../utils/TurnInto"
import CommandSelect, { type CommandSelectOption } from "../ui/CommandSelect"

const BubbleMenu = ({ editor, className, ...props }: any) => {
    const [turnIntoOptions, setTurnIntoOptions] = useState<CommandSelectOption[]>([])
    const [turnInto, setTurnInto] = useState<TurnIntoValue>("paragraph")
    const bubbleMenuItemClasses = "hover:bg-gray-700 w-7 h-7 flex items-center justify-center rounded-md py-1 px-2 cursor-pointer";

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
        <TipTapBubbleMenu editor={editor} className={`bg-gray-800 shadow rounded-lg text-sm flex gap-2 py-2 px-4 border border-gray-600 text-white ${className}`} {...props}>
            <button
                onClick={() => editor.chain().focus().toggleBold().run()}
                className={`${bubbleMenuItemClasses} ${editor.isActive("bold") ? "bg-gray-600" : "bg-transparent"}`}
                type="button"
            >
                <strong>B</strong>
            </button>
            <button
                onClick={() => editor.chain().focus().toggleItalic().run()}
                className={`${bubbleMenuItemClasses} ${editor.isActive("italic") ? "bg-gray-600" : "bg-transparent"}`}
                type="button"
            >
                <em>I</em>
            </button>
            <button
                onClick={() => editor.chain().focus().toggleUnderline().run()}
                className={`${bubbleMenuItemClasses} ${editor.isActive("underline") ? "bg-gray-600" : "bg-transparent"}`}
                type="button"
            >
                <u>U</u>
            </button>
            <button
                onClick={() => {
                    const url = window.prompt("URL")
                    if (url) editor.chain().focus().setLink({ href: url }).run()
                }}
                className={`${bubbleMenuItemClasses} ${editor.isActive("link") ? "bg-gray-600" : "bg-transparent"}`}
                type="button"
            >
                🔗
            </button>
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
        </TipTapBubbleMenu>
    )
}

export default BubbleMenu