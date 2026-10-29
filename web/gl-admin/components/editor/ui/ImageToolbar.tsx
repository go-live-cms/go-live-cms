import { useCallback, useEffect, useState, type ReactNode } from "react"
import { BubbleMenu as TipTapBubbleMenu } from "@tiptap/react/menus"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import Tooltip from "@gl-admin/components/ui/Tooltip"
import type { ImageAlign } from "@gl-admin/lib/blocks-spec"
import { findSelectedImage } from "../extensions/ImageWithMediaId"

/** Safely check if editor view is mounted (TipTap v3 throws on .view access) */
function isViewMounted(editor: TiptapEditor): boolean {
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

/**
 * The image toolbar (#346): width (content, wide, full) and the caption on/off. Shown
 * while the image itself is selected; the caption has the selection toolbar.
 */
const ImageToolbar = ({ editor }: ImageToolbarProps) => {
  const [state, setState] = useState<{ align: ImageAlign; hasCaption: boolean }>({ align: "inline", hasCaption: false })

  const update = useCallback(() => {
    const image = editor ? findSelectedImage(editor.state) : null
    if (!image) return
    setState({ align: image.node.attrs.align ?? "inline", hasCaption: image.node.childCount > 0 })
  }, [editor])

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
      shouldShow={({ editor: e, state: s }) =>
        isViewMounted(e) && e.isEditable && s.selection instanceof NodeSelection && s.selection.node.type.name === "image"
      }
    >
      <div role="toolbar" aria-label="Image" className="editor-toolbar__group">
        {WIDTHS.map((width) => (
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
        <span aria-hidden="true" className="editor-toolbar__divider" />
        <Tooltip content={state.hasCaption ? "Remove caption" : "Add caption"} placement="top">
          <button
            type="button"
            className="editor-toolbar__button"
            aria-label="Caption"
            aria-pressed={state.hasCaption}
            onClick={() => editor.chain().focus().toggleImageCaption().run()}
          >
            <CaptionIcon />
          </button>
        </Tooltip>
      </div>
    </TipTapBubbleMenu>
  )
}

export default ImageToolbar
