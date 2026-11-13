import { useEffect, useState, useCallback } from "react"
import { BubbleMenu as TipTapBubbleMenu } from "@tiptap/react/menus"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { applyTurnInto, computeTurnIntoFromSelection, type TurnIntoValue } from "../utils/turnInto"
import { turnIntoEntries } from "../blocks/catalog"
import CommandSelect, { type CommandSelectOption } from "./CommandSelect"
import { FLOATING_TOOLBAR_ATTR, onFloatingToolbarKeyDown } from "../utils/floatingToolbar"
import { BlockIcon, catalogSelectOptions } from "./BlockIcon"
import { findCallout } from "../extensions/Callout"
import {
  CALLOUT_TONE_ICONS,
  CALLOUT_TONE_LABELS,
  CALLOUT_TONES,
  normalizeCalloutTone,
  type CalloutTone,
} from "@gl-admin/lib/blocks-spec"

/** The block type picker's options: the catalog's paragraph and headings 1–6 (#415). */
const blockTypeOptions: CommandSelectOption[] = catalogSelectOptions(
  turnIntoEntries().filter((entry) => entry.type === "paragraph" || entry.type === "heading")
)

/** The callout's Type picker (#419, "Type Warning ▾" on the blocks canvas): each tone with its icon. */
export const calloutToneOptions: CommandSelectOption[] = CALLOUT_TONES.map((tone) => ({
  value: tone,
  label: CALLOUT_TONE_LABELS[tone],
  label_icon: <BlockIcon icon={{ path: CALLOUT_TONE_ICONS[tone] }} />,
}))

/** The tone of the callout holding the selection, or null outside one. */
function calloutToneAt(editor: TiptapEditor): CalloutTone | null {
  const callout = findCallout(editor.state)
  return callout ? normalizeCalloutTone(callout.node.attrs.tone) : null
}

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
  const [calloutTone, setCalloutTone] = useState<CalloutTone | null>(null)

  const updateBlockType = useCallback(() => {
    if (!editor) return
    const v = computeTurnIntoFromSelection(editor)
    setBlockType(v)
    setCalloutTone(calloutToneAt(editor))
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

  const isAligned = (align: "left" | "center" | "right") =>
    align === "left"
      ? editor.isActive({ textAlign: "left" }) || (!editor.isActive({ textAlign: "center" }) && !editor.isActive({ textAlign: "right" }))
      : editor.isActive({ textAlign: align })

  return (
    <TipTapBubbleMenu
      editor={editor}
      pluginKey="blockTypeToolbar"
      className="editor-toolbar block-type-toolbar"
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
      <div
        role="toolbar"
        aria-label="Block"
        className="editor-toolbar__group"
        {...{ [FLOATING_TOOLBAR_ATTR]: "" }}
        onKeyDown={(e) => onFloatingToolbarKeyDown(e, editor)}
      >
        <CommandSelect
          options={blockTypeOptions}
          value={blockType}
          label="Block type"
          onChange={(option: CommandSelectOption) => {
            if (!editor) return
            const val = option.value as TurnIntoValue
            setBlockType(val)
            applyTurnInto(editor, val)
          }}
        />
        <span aria-hidden="true" className="editor-toolbar__divider" />
        {calloutTone && (
          <>
            <CommandSelect
              options={calloutToneOptions}
              value={calloutTone}
              label="Callout type"
              disabled={!editor.isEditable}
              onChange={(option: CommandSelectOption) => {
                // `editable` can change while the picker is open (a demotion, #313): a
                // read-only connection's edit would be dropped by the server.
                if (!editor.isEditable) return
                const tone = normalizeCalloutTone(option.value)
                setCalloutTone(tone)
                editor.chain().focus().setCalloutTone(tone).run()
              }}
            />
            <span aria-hidden="true" className="editor-toolbar__divider" />
          </>
        )}
        {/* Text alignment */}
        <button
          type="button"
          className="editor-toolbar__button"
          aria-label="Align left"
          aria-pressed={isAligned("left")}
          onClick={() => editor.chain().focus().setTextAlign("left").run()}
        >
          <AlignLeftIcon />
        </button>
        <button
          type="button"
          className="editor-toolbar__button"
          aria-label="Align center"
          aria-pressed={isAligned("center")}
          onClick={() => editor.chain().focus().setTextAlign("center").run()}
        >
          <AlignCenterIcon />
        </button>
        <button
          type="button"
          className="editor-toolbar__button"
          aria-label="Align right"
          aria-pressed={isAligned("right")}
          onClick={() => editor.chain().focus().setTextAlign("right").run()}
        >
          <AlignRightIcon />
        </button>
      </div>
    </TipTapBubbleMenu>
  )
}

export default BlockTypeToolbar