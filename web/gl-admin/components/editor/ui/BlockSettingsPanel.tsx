import { useCallback, useEffect, useState } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { NodeSelection } from "prosemirror-state"
import { authManager } from "@gl-admin/lib/auth"
import {
  GROUP_ALIGNS,
  GROUP_STYLES,
  isGroupAlign,
  isGroupStyle,
  type GroupAlign,
  type GroupStyle,
} from "@gl-admin/lib/blocks-spec"
import { catalogEntries, embedEntryId, type BlockIconSpec } from "../blocks/catalog"
import { BlockIcon } from "./BlockIcon"
import Switch from "../../ui/Switch"
import { DETAILS_OPEN_HELP, DETAILS_OPEN_LABEL } from "../extensions/DetailsBlock"
import MediaBlockSettings from "./MediaBlockSettings"
import Segment from "./BlockSettingsSegment"
import { ButtonsSettings, ColumnsSettings, SpacerSettings } from "./LayoutBlockSettings"
import GallerySettings from "./GallerySettings"
import { galleryImageCount } from "../extensions/GalleryBlock"
import EmbedBlockSettings from "./EmbedBlockSettings"
import {
  ancestorBlocks,
  blockSpecTypeOf,
  editorBlockAtSelection,
  keepBlockSelected,
  refOfBlock,
  resolveEditorBlock,
  type BlockRef,
  type EditorBlock,
} from "../utils/blockTree"

// The settings panel's Block tab (#417; the canvas's settings panel, "Post · Block"): the
// block the selection is on or in, at any depth (a paragraph inside a group as well as the
// group), its place ("Group › Paragraph", each container a button that selects it), and its
// settings. Today only containers have settings here (a group's Width and Background, a
// details' Open by default, #421: the same as their toolbars), and the media blocks their
// file with Replace (#423); other blocks keep theirs on their toolbars.
//
// It reads the editor's state and changes a block with one `setNodeMarkup`, found by its id
// when the button is pressed (a collaborator's edit moves positions, never ids). No plugin,
// no appendTransaction (rule 7).

const WIDTH_LABELS: Record<GroupAlign, string> = { content: "Content", wide: "Wide", full: "Full" }
const BACKGROUND_LABELS: Record<GroupStyle, string> = { none: "None", tinted: "Tinted" }

// #428, the canvas's Custom HTML settings, plus what happens to what's written.
function htmlBlockHint(role: string | null | undefined): string {
  return role?.toLowerCase() === "admin"
    ? "Only admins can add or edit this block. Editors and contributors see it as a locked preview and can still move it. Scripts, event handlers and frames are removed when it's saved."
    : "View only: only admins can edit custom HTML. Ask an admin to change it."
}

type BlockInfo = { name: string; icon: BlockIconSpec }

/** The catalog's name and icon for a block (a heading by its level), else its type. */
export function blockInfo(block: Pick<EditorBlock, "node">): BlockInfo {
  const type = blockSpecTypeOf(block.node.type.name)
  const entries = catalogEntries()
  const entry =
    type === "heading"
      ? entries.find((e) => e.id === `heading-${Number(block.node.attrs.level) || 1}`)
      : type === "embed"
        ? entries.find((e) => e.id === embedEntryId(block.node.attrs.provider))
        : entries.find((e) => e.type === type)
  if (entry) return { name: entry.name, icon: entry.icon }
  if (block.node.type.name === "listItem") return { name: "List item", icon: { glyph: "•" } }
  // #426: not in the catalog (it only exists inside a columns block).
  if (block.node.type.name === "column") return { name: "Column", icon: { path: "M3 4h18v16H3z" } }
  return { name: type, icon: { glyph: "?" } }
}

type Snapshot = { block: EditorBlock; path: EditorBlock[] } | null

function snapshot(editor: TiptapEditor): Snapshot {
  if (editor.isDestroyed) return null
  const block = editorBlockAtSelection(editor.state)
  return block ? { block, path: ancestorBlocks(editor.state.doc, block) } : null
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
    (ref: BlockRef, attr: string, value: string | boolean | number) => {
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

  // #424: a gallery's image shows the gallery's panel with that image's row open.
  const parent = state.path[state.path.length - 1]
  const inGallery = state.block.node.type.name === "image" && parent?.node.type.name === "gallery"
  const selectedImageId = inGallery ? refOfBlock(state.block).id : null
  const block = inGallery ? parent : state.block
  const path = inGallery ? state.path.slice(0, -1) : state.path
  const ref = refOfBlock(block)
  const info = blockInfo(block)
  const isGallery = block.node.type.name === "gallery"
  const isGroup = block.node.type.name === "group"
  const isDetails = block.node.type.name === "details"
  // #423: the file a media block shows, with Replace.
  const isMedia = ["image", "video", "audio", "file"].includes(block.node.type.name)

  return (
    <div className="block-settings">
      <div className="block-settings__identity">
        <span className="block-settings__tile" aria-hidden="true">
          <BlockIcon icon={info.icon} />
        </span>
        <div>
          <b className="block-settings__name">{info.name}</b>
          {isGallery && <span className="block-settings__sub">{galleryImageCount(block.node)}</span>}
        </div>
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
      ) : isDetails ? (
        // #421, the canvas's Details settings.
        <Switch
          className="block-settings__switch"
          label={DETAILS_OPEN_LABEL}
          description={DETAILS_OPEN_HELP}
          checked={block.node.attrs.open === true}
          disabled={!editor.isEditable}
          onChange={(open) => setAttr(ref, "open", open)}
        />
      ) : isMedia ? (
        <MediaBlockSettings editor={editor} node={block.node} blockRef={ref} />
      ) : isGallery ? (
        <GallerySettings
          editor={editor}
          gallery={block.node}
          galleryPos={block.pos}
          selectedId={selectedImageId}
          onColumns={(columns) => setAttr(ref, "columns", columns)}
        />
      ) : block.node.type.name === "embed" ? (
        <EmbedBlockSettings key={ref.id ?? ref.pos} editor={editor} node={block.node} blockRef={ref} />
      ) : block.node.type.name === "html" ? (
        <p className="post-settings__hint">{htmlBlockHint(authManager.getState().user?.role)}</p>
      ) : block.node.type.name === "columns" ? (
        <ColumnsSettings editor={editor} block={block} />
      ) : block.node.type.name === "buttons" ? (
        <ButtonsSettings editor={editor} block={block} />
      ) : block.node.type.name === "spacer" ? (
        <SpacerSettings editor={editor} block={block} />
      ) : (
        <p className="post-settings__hint">This block has no settings here. Its toolbar has its options.</p>
      )}
    </div>
  )
}
