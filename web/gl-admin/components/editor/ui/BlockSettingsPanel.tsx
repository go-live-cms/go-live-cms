import { useCallback, useEffect, useState } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { NodeSelection, type EditorState, type Transaction } from "prosemirror-state"
import {
  GROUP_ALIGNS,
  GROUP_STYLES,
  isGroupAlign,
  isGroupStyle,
  type GroupAlign,
  type GroupStyle,
} from "@gl-admin/lib/blocks-spec"
import { catalogEntries, type BlockIconSpec } from "../blocks/catalog"
import { BlockIcon } from "./BlockIcon"
import MediaBlockSettings from "./MediaBlockSettings"
import {
  ancestorBlocks,
  blockSpecTypeOf,
  editorBlockAtSelection,
  refOfBlock,
  resolveEditorBlock,
  type BlockRef,
  type EditorBlock,
} from "../utils/blockTree"

// The settings panel's Block tab (#417; the canvas's settings panel, "Post · Block"): the
// block the selection is on or in, at any depth (a paragraph inside a group as well as the
// group), its place ("Group › Paragraph", each container a button that selects it), and its
// settings. Today only containers have settings here (a group's Width and Background, the
// same as its toolbar), and the media blocks their file with Replace (#423); other blocks
// keep theirs on their toolbars.
//
// It reads the editor's state and changes a block with one `setNodeMarkup`, found by its id
// when the button is pressed (a collaborator's edit moves positions, never ids). No plugin,
// no appendTransaction (rule 7).

const WIDTH_LABELS: Record<GroupAlign, string> = { content: "Content", wide: "Wide", full: "Full" }
const BACKGROUND_LABELS: Record<GroupStyle, string> = { none: "None", tinted: "Tinted" }

type BlockInfo = { name: string; icon: BlockIconSpec }

/** The catalog's name and icon for a block (a heading by its level), else its type. */
export function blockInfo(block: Pick<EditorBlock, "node">): BlockInfo {
  const type = blockSpecTypeOf(block.node.type.name)
  const entries = catalogEntries()
  const entry =
    type === "heading"
      ? entries.find((e) => e.id === `heading-${Number(block.node.attrs.level) || 1}`)
      : entries.find((e) => e.type === type)
  if (entry) return { name: entry.name, icon: entry.icon }
  if (block.node.type.name === "listItem") return { name: "List item", icon: { glyph: "•" } }
  return { name: type, icon: { glyph: "?" } }
}

/**
 * A selected block stays selected through a change of its own attributes: ProseMirror maps
 * a NodeSelection through `setNodeMarkup` to a caret inside it.
 */
export function keepBlockSelected(state: EditorState, pos: number, tr: Transaction): Transaction {
  if (state.selection instanceof NodeSelection && state.selection.from === pos) tr.setSelection(NodeSelection.create(tr.doc, pos))
  return tr
}

type Snapshot = { block: EditorBlock; path: EditorBlock[] } | null

function snapshot(editor: TiptapEditor): Snapshot {
  if (editor.isDestroyed) return null
  const block = editorBlockAtSelection(editor.state)
  return block ? { block, path: ancestorBlocks(editor.state.doc, block) } : null
}

function Segment<T extends string>({
  label,
  values,
  labels,
  value,
  onPick,
}: {
  label: string
  values: readonly T[]
  labels: Record<T, string>
  value: T
  onPick: (value: T) => void
}) {
  const id = `block-settings-${label.toLowerCase()}`
  return (
    <div className="post-settings__field">
      <span className="post-settings__label" id={id}>
        {label}
      </span>
      <div className="block-settings__segment" role="radiogroup" aria-labelledby={id}>
        {values.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === value}
            className="block-settings__option"
            onClick={() => onPick(option)}
          >
            {labels[option]}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function BlockSettingsPanel({ editor }: { editor: TiptapEditor }) {
  const [state, setState] = useState<Snapshot>(() => snapshot(editor))

  useEffect(() => {
    // Typing in a block gives it a new node, so it re-renders then; a transaction that
    // leaves the selected block and its containers as they were keeps the panel as it is.
    const update = () =>
      setState((previous) => {
        const next = snapshot(editor)
        if (!previous || !next) return next
        const same =
          previous.block.node === next.block.node &&
          previous.block.pos === next.block.pos &&
          previous.path.length === next.path.length &&
          previous.path.every((container, i) => container.node === next.path[i].node)
        return same ? previous : next
      })
    update()
    editor.on("transaction", update)
    return () => {
      editor.off("transaction", update)
    }
  }, [editor])

  const select = useCallback(
    (ref: BlockRef) => {
      const block = resolveEditorBlock(editor.state.doc, ref)
      if (!block) return
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, block.pos)).scrollIntoView())
      editor.view.focus()
    },
    [editor]
  )

  const setAttr = useCallback(
    (ref: BlockRef, attr: string, value: string) => {
      if (!editor.isEditable) return
      const block = resolveEditorBlock(editor.state.doc, ref)
      if (!block || block.node.attrs[attr] === value) return
      editor.view.dispatch(keepBlockSelected(editor.state, block.pos, editor.state.tr.setNodeMarkup(block.pos, undefined, { ...block.node.attrs, [attr]: value })))
    },
    [editor]
  )

  if (!state) {
    return <p className="post-settings__hint block-settings__empty">Select a block, or put the cursor in one, to see its settings.</p>
  }

  const { block, path } = state
  const ref = refOfBlock(block)
  const info = blockInfo(block)
  const isGroup = block.node.type.name === "group"
  // #423: the file a media block shows, with Replace.
  const isMedia = ["image", "video", "audio", "file"].includes(block.node.type.name)

  return (
    <div className="block-settings">
      <div className="block-settings__identity">
        <span className="block-settings__tile" aria-hidden="true">
          <BlockIcon icon={info.icon} />
        </span>
        <b className="block-settings__name">{info.name}</b>
      </div>
      {path.length > 0 && (
        <nav className="block-settings__path" aria-label="Inside">
          {path.map((container) => {
            const containerRef = refOfBlock(container)
            return (
              <span key={containerRef.id ?? containerRef.pos} className="block-settings__crumb">
                <button type="button" className="block-settings__crumb-button" onClick={() => select(containerRef)}>
                  {blockInfo(container).name}
                </button>
                <span aria-hidden="true">›</span>
              </span>
            )
          })}
          <span aria-current="true">{info.name}</span>
        </nav>
      )}
      {isGroup ? (
        <fieldset className="post-settings__fieldset" disabled={!editor.isEditable}>
          <Segment
            label="Width"
            values={GROUP_ALIGNS}
            labels={WIDTH_LABELS}
            value={isGroupAlign(block.node.attrs.align) ? block.node.attrs.align : "content"}
            onPick={(value) => setAttr(ref, "align", value)}
          />
          <Segment
            label="Background"
            values={GROUP_STYLES}
            labels={BACKGROUND_LABELS}
            value={isGroupStyle(block.node.attrs.style) ? block.node.attrs.style : "none"}
            onPick={(value) => setAttr(ref, "style", value)}
          />
        </fieldset>
      ) : isMedia ? (
        <MediaBlockSettings editor={editor} node={block.node} blockRef={ref} />
      ) : (
        <p className="post-settings__hint">This block has no settings here. Its toolbar has its options.</p>
      )}
    </div>
  )
}
