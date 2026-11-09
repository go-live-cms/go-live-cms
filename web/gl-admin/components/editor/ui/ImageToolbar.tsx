import { useCallback, useEffect, useState, type ReactNode } from "react"
import { BubbleMenu as TipTapBubbleMenu } from "@tiptap/react/menus"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import Tooltip from "@gl-admin/components/ui/Tooltip"
import type { ImageAlign } from "@gl-admin/lib/blocks-spec"
import { findSelectedMediaBlock, MEDIA_NODE_NAMES } from "../extensions/MediaBlocks"
import { chooseMediaFor } from "../blocks/mediaPicking"

/** Safely check if editor view is mounted (TipTap v3 throws on .view access) */
export function isViewMounted(editor: TiptapEditor): boolean {
  try {
    return !!editor?.view?.dom?.parentElement
  } catch {
    return false
  }
}

const icon = (children: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)

const WIDTHS: { value: ImageAlign; label: string; icon: ReactNode }[] = [
  {
    value: "inline",
    label: "Content width",
    icon: icon(
      <>
        <rect x="7" y="7" width="10" height="10" rx="1.5" />
        <path d="M3 4h18M3 20h18" />
      </>,
    ),
  },
  {
    value: "wide",
    label: "Wide width",
    icon: icon(
      <>
        <rect x="4" y="7" width="16" height="10" rx="1.5" />
        <path d="M3 4h18M3 20h18" />
      </>,
    ),
  },
  {
    value: "full",
    label: "Full width",
    icon: icon(
      <>
        <rect x="1" y="7" width="22" height="10" rx="1" />
        <path d="M3 4h18M3 20h18" />
      </>,
    ),
  },
]

const CaptionIcon = () =>
  icon(
    <>
      <rect x="3" y="3" width="18" height="12" rx="1.5" />
      <path d="M6 19h12" />
    </>,
  )

interface ImageToolbarProps {
  editor: TiptapEditor
}

const LABELS: Record<string, string> = { image: "Image", video: "Video", audio: "Audio", file: "File" }
const isMediaSelection = (selection: unknown) =>
  selection instanceof NodeSelection && (MEDIA_NODE_NAMES as readonly string[]).includes(selection.node.type.name)

/**
 * The media blocks' toolbar: an image's width (content, wide, full) and caption on/off
 * (#346), and since #423 every media block's Replace (the shared picker, `mediaPicking.ts`)
 * and the caption of a video or audio block. Shown while the block itself is selected; a
 * caption has the selection toolbar.
 */
const ImageToolbar = ({ editor }: ImageToolbarProps) => {
  const [state, setState] = useState<{ name: string; align: ImageAlign; hasCaption: boolean; hasFile: boolean }>({
    name: "image",
    align: "inline",
    hasCaption: false,
    hasFile: false,
  })

  const update = useCallback(() => {
    const block = editor ? findSelectedMediaBlock(editor.state) : null
    if (!block) return
    setState({
      name: block.node.type.name,
      align: block.node.attrs.align ?? "inline",
      hasCaption: block.node.childCount > 0,
      hasFile: typeof block.node.attrs.mediaId === "number",
    })
  }, [editor])

  const replace = () => {
    const block = findSelectedMediaBlock(editor.state)
    if (block) chooseMediaFor(editor, block.pos)
  }

  useEffect(() => {
    if (!editor) return
    update()
    editor.on("selectionUpdate", update)
    editor.on("transaction", update)
    return () => {
      editor.off("selectionUpdate", update)
      editor.off("transaction", update)
    }
  }, [editor, update])

  if (!editor) return null

  return (
    <TipTapBubbleMenu
      editor={editor}
      pluginKey="imageToolbar"
      className="editor-toolbar image-toolbar"
      shouldShow={({ editor: e, state: s }) => isViewMounted(e) && e.isEditable && isMediaSelection(s.selection)}
    >
      <div role="toolbar" aria-label={LABELS[state.name] ?? "Media"} className="editor-toolbar__group">
        {state.name === "image" && WIDTHS.map((width) => (
          <Tooltip key={width.value} content={width.label} placement="top">
            <button
              type="button"
              className="editor-toolbar__button"
              aria-label={width.label}
              aria-pressed={state.align === width.value}
              onClick={() => editor.chain().focus().setImageAlign(width.value).run()}
            >
              {width.icon}
            </button>
          </Tooltip>
        ))}
        {state.name === "image" && <span aria-hidden="true" className="editor-toolbar__divider" />}
        {state.name !== "file" && (
          <Tooltip content={state.hasCaption ? "Remove caption" : "Add caption"} placement="top">
            <button
              type="button"
              className="editor-toolbar__button"
              aria-label="Caption"
              aria-pressed={state.hasCaption}
              onClick={() =>
                state.name === "image"
                  ? editor.chain().focus().toggleImageCaption().run()
                  : editor.chain().focus().toggleMediaCaption().run()
              }
            >
              <CaptionIcon />
            </button>
          </Tooltip>
        )}
        {state.name !== "file" && <span aria-hidden="true" className="editor-toolbar__divider" />}
        <button type="button" className="editor-toolbar__button editor-toolbar__button--text" onClick={replace}>
          {state.hasFile ? "Replace" : "Choose from Media"}
        </button>
      </div>
    </TipTapBubbleMenu>
  )
}

export default ImageToolbar
