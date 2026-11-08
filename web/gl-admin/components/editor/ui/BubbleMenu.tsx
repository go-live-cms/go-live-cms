import { useEffect, useState, useCallback, type CSSProperties, type ReactNode } from "react"
import { BubbleMenu as TipTapBubbleMenu } from "@tiptap/react/menus"
import { turnIntoEntries } from "../blocks/catalog"
import { applyTurnInto, computeTurnIntoFromSelection, type TurnIntoValue } from "../utils/turnInto"
import CommandSelect, { type CommandSelectOption } from "../ui/CommandSelect"
import { catalogSelectOptions } from "./BlockIcon"
import { NodeSelection } from "@tiptap/pm/state"
import { CAPTION_MARKS } from "@gl-admin/lib/blocks-spec"

/** Safely check if editor view is mounted (TipTap v3 throws on .view access) */
function isViewMounted(editor: any): boolean {
  try {
    return !!editor?.view?.dom?.parentElement
  } catch {
    return false
  }
}

const CodeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
  </svg>
)
const LinkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </svg>
)

const HighlightIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 11-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
  </svg>
)
// "x²" / "x₂", as the canvas draws them (the button's name is its aria-label).
const ScriptLabel = ({ kind }: { kind: "sup" | "sub" }) => {
  const Tag = kind
  return (
    <span aria-hidden="true" style={{ fontSize: 13 }}>
      x<Tag style={{ fontSize: 9 }}>2</Tag>
    </span>
  )
}

// The selection toolbar ("Editor menus & states"): turn into, marks, link. Comment (#192)
// isn't built yet, so it isn't shown.
const BubbleMenu = ({ editor, className = "", openLinkModal, ...props }: any) => {
  const [turnIntoOptions, setTurnIntoOptions] = useState<CommandSelectOption[]>([])
  const [turnInto, setTurnInto] = useState<TurnIntoValue>("paragraph")

  useEffect(() => {
    if (!editor) return
    setTurnIntoOptions(catalogSelectOptions(turnIntoEntries()))
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

  // In an image or table caption (#346, #420): no "turn into", and only the marks a
  // caption allows. In a table cell (paragraphs only, #420): no "turn into" either.
  const { $from } = editor.state.selection
  const inCaption = $from.parent.type.name === "imageCaption" || $from.parent.type.name === "tableCaption"
  const inCell = $from.depth > 1 && !!$from.node($from.depth - 1).type.spec.tableRole
  const mark = (name: string, label: string, run: () => void, content: ReactNode, style?: CSSProperties) =>
    inCaption && !(CAPTION_MARKS as readonly string[]).includes(name) ? null : (
      <button
        type="button"
        aria-label={label}
        aria-pressed={editor.isActive(name)}
        className="editor-toolbar__button"
        style={style}
        onClick={run}
      >
        {content}
      </button>
    )

  return (
    <TipTapBubbleMenu
      editor={editor}
      className={`editor-toolbar ${className}`}
      shouldShow={({ editor: e }) => {
        // Prevent positioning when view is not fully mounted (avoids domFromPos null error)
        if (!isViewMounted(e)) return false
        // A selected media block has its own toolbar (ImageToolbar: #346, #423).
        const { selection } = e.state
        if (selection instanceof NodeSelection && ["image", "video", "audio", "file"].includes(selection.node.type.name)) return false
        // Default: show when there's a text selection
        const { from, to } = selection
        return from !== to
      }}
      {...props}
    >
      <div role="toolbar" aria-label="Format text" className="editor-toolbar__group">
        {!inCaption && !inCell && (
          <>
            <CommandSelect
              options={turnIntoOptions}
              value={turnInto}
              label="Turn into"
              onChange={(option: CommandSelectOption) => {
                if (!editor) return
                const val = option.value as TurnIntoValue
                setTurnInto(val)
                applyTurnInto(editor, val)
              }}
            />
            <span aria-hidden="true" className="editor-toolbar__divider" />
          </>
        )}
        {mark("bold", "Bold", () => editor.chain().focus().toggleBold().run(), "B", { fontWeight: 700 })}
        {mark("italic", "Italic", () => editor.chain().focus().toggleItalic().run(), "i", {
          fontFamily: "Georgia, serif",
          fontStyle: "italic",
        })}
        {mark("underline", "Underline", () => editor.chain().focus().toggleUnderline().run(), "U", {
          textDecoration: "underline",
        })}
        {mark("strike", "Strikethrough", () => editor.chain().focus().toggleStrike().run(), "S", {
          textDecoration: "line-through",
        })}
        {mark("code", "Inline code", () => editor.chain().focus().toggleCode().run(), <CodeIcon />)}
        {mark("link", "Link", openLinkModal, <LinkIcon />)}
        {/* #418 ("Editor · text blocks", Paragraph). Not in a caption (CAPTION_MARKS). */}
        {!inCaption && (
          <>
            <span aria-hidden="true" className="editor-toolbar__divider" />
            {mark("highlight", "Highlight", () => editor.chain().focus().toggleHighlight().run(), <HighlightIcon />)}
            {mark("superscript", "Superscript", () => editor.chain().focus().toggleSuperscript().run(), <ScriptLabel kind="sup" />)}
            {mark("subscript", "Subscript", () => editor.chain().focus().toggleSubscript().run(), <ScriptLabel kind="sub" />)}
          </>
        )}
      </div>
    </TipTapBubbleMenu>
  )
}

export default BubbleMenu
