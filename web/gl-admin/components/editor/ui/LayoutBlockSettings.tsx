import { useEffect, useReducer, useState } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { NodeSelection } from "prosemirror-state"
import {
  BUTTON_VARIANTS,
  BUTTONS_ALIGNS,
  buttonHrefFromInput,
  COLUMNS_LAYOUT_LABELS,
  columnsLayoutFor,
  DEFAULT_BUTTON_VARIANT,
  GROUP_ALIGNS,
  isButtonsAlign,
  isButtonVariant,
  isGroupAlign,
  normalizeButtonHref,
  normalizeSpacerSize,
  SPACER_SIZES,
  spacerPx,
  TWO_COLUMN_LAYOUTS,
  type ButtonsAlign,
  type ButtonVariant,
  type GroupAlign,
  type SpacerSize,
} from "@gl-admin/lib/blocks-spec"
import { currentButton } from "../extensions/ButtonsBlock"
import { refOfBlock, resolveEditorBlock, type BlockRef, type EditorBlock } from "../utils/blockTree"
import { setColumnCount } from "../utils/columnActions"
import Segment from "./BlockSettingsSegment"

// The settings panel's Block tab for the layout blocks (#426, the canvas's "Editor · columns,
// group, buttons, spacer" settings column). The same changes as their toolbars.

const WIDTH_LABELS: Record<GroupAlign, string> = { content: "Content", wide: "Wide", full: "Full" }
const STYLE_LABELS: Record<ButtonVariant, string> = { primary: "Primary", secondary: "Secondary" }
const ALIGN_LABELS: Record<ButtonsAlign, string> = { left: "Left", center: "Centre" }
const COUNTS = ["2", "3", "4"] as const
const COUNT_LABELS: Record<(typeof COUNTS)[number], string> = { "2": "2", "3": "3", "4": "4" }
const SPACER_LABELS = Object.fromEntries(SPACER_SIZES.map((size) => [size, String(spacerPx(size))])) as Record<SpacerSize, string>

export const REMOVED_COLUMN_HELP = "A removed column's blocks move to the last column."

function useSetAttr(editor: TiptapEditor) {
  return (ref: BlockRef, attr: string, value: string) => {
    if (!editor.isEditable) return
    const block = resolveEditorBlock(editor.state.doc, ref)
    if (!block || block.node.attrs[attr] === value) return
    const tr = editor.state.tr.setNodeMarkup(block.pos, undefined, { ...block.node.attrs, [attr]: value })
    if (editor.state.selection instanceof NodeSelection && editor.state.selection.from === block.pos) {
      tr.setSelection(NodeSelection.create(tr.doc, block.pos))
    }
    editor.view.dispatch(tr)
  }
}

export function ColumnsSettings({ editor, block }: { editor: TiptapEditor; block: EditorBlock }) {
  const ref = refOfBlock(block)
  const setAttr = useSetAttr(editor)
  const count = block.node.childCount
  const layout = columnsLayoutFor(block.node.attrs.layout, count)
  const countValue = (COUNTS as readonly string[]).includes(String(count)) ? (String(count) as (typeof COUNTS)[number]) : "2"
  return (
    <fieldset className="post-settings__fieldset" disabled={!editor.isEditable}>
      <Segment label="Columns" values={COUNTS} labels={COUNT_LABELS} value={countValue} onPick={(value) => setColumnCount(editor, ref, Number(value))} />
      <p className="post-settings__hint">{REMOVED_COLUMN_HELP}</p>
      {count === 2 && (
        <Segment
          label="Layout"
          values={TWO_COLUMN_LAYOUTS}
          labels={COLUMNS_LAYOUT_LABELS}
          value={layout === "equal" ? "50-50" : (layout as (typeof TWO_COLUMN_LAYOUTS)[number])}
          onPick={(value) => setAttr(ref, "layout", value)}
        />
      )}
      <p className="post-settings__hint">On phones the columns stack in order, the first one on top.</p>
      <Segment
        label="Width"
        values={GROUP_ALIGNS}
        labels={WIDTH_LABELS}
        value={isGroupAlign(block.node.attrs.align) ? block.node.attrs.align : "content"}
        onPick={(value) => setAttr(ref, "align", value)}
      />
    </fieldset>
  )
}

export function ButtonsSettings({ editor, block }: { editor: TiptapEditor; block: EditorBlock }) {
  // The panel re-renders when the block changes; moving between its buttons doesn't.
  const [, refresh] = useReducer((count: number) => count + 1, 0)
  useEffect(() => {
    const update = () => refresh()
    editor.on("selectionUpdate", update)
    return () => {
      editor.off("selectionUpdate", update)
    }
  }, [editor])
  const button = currentButton(editor.state, { pos: block.pos, node: block.node })
  const href = normalizeButtonHref(button?.node.attrs.href) ?? ""
  const [value, setValue] = useState(href)
  const [error, setError] = useState<string | null>(null)
  // Another button picked, or a collaborator's change: the field shows what's stored.
  useEffect(() => {
    setValue(href)
    setError(null)
  }, [href, button?.pos])

  const apply = () => {
    if (!editor.isEditable || value === href) return
    const result = buttonHrefFromInput(value)
    if ("error" in result) {
      setError(result.error)
      return
    }
    setError(null)
    editor.commands.setButtonLink(result.href)
  }

  const variant = isButtonVariant(button?.node.attrs.variant) ? button!.node.attrs.variant : DEFAULT_BUTTON_VARIANT
  const count = block.node.childCount
  return (
    <fieldset className="post-settings__fieldset" disabled={!editor.isEditable}>
      <p className="post-settings__hint">{count === 1 ? "A row with one button." : `In a row of ${count} buttons.`}</p>
      <div className="post-settings__field">
        <label className="post-settings__label" htmlFor="block-settings-button-link">
          Link
        </label>
        <input
          id="block-settings-button-link"
          className="block-settings__input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={value}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setValue(event.target.value)
            setError(null)
          }}
          onBlur={apply}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              apply()
            }
          }}
        />
        {error && (
          <p className="block-settings__error" role="alert">
            {error}
          </p>
        )}
      </div>
      <Segment label="Style" values={BUTTON_VARIANTS} labels={STYLE_LABELS} value={variant} onPick={(next) => editor.commands.setButtonVariant(next)} />
      <Segment
        label="Row alignment"
        values={BUTTONS_ALIGNS}
        labels={ALIGN_LABELS}
        value={isButtonsAlign(block.node.attrs.align) ? block.node.attrs.align : "left"}
        onPick={(next) => editor.commands.setButtonsAlign(next)}
      />
      <p className="post-settings__hint">Applies to every button in this row.</p>
    </fieldset>
  )
}

export function SpacerSettings({ editor, block }: { editor: TiptapEditor; block: EditorBlock }) {
  const ref = refOfBlock(block)
  const setAttr = useSetAttr(editor)
  return (
    <fieldset className="post-settings__fieldset" disabled={!editor.isEditable}>
      <Segment label="Height" values={SPACER_SIZES} labels={SPACER_LABELS} value={normalizeSpacerSize(block.node.attrs.size)} onPick={(value) => setAttr(ref, "size", value)} />
      <p className="post-settings__hint">In px, from the theme's spacing scale. With the handle focused, ↑ ↓ move one step.</p>
    </fieldset>
  )
}
