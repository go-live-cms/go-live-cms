import { useMemo, useRef, useState } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import Modal from "@gl-admin/components/ui/Modal"
import { toast } from "@gl-admin/components/ui/Toast"
import { listHeadings, moveBlockUnder, resolveBlock, type BlockRef, type HeadingTarget } from "../utils/blockActions"

// Move to (#356, Ctrl Shift P): pick one of the post's headings; the block (and everything
// in it) moves right under it, in one transaction (blockActions.ts). The list is read when
// the dialog opens; the move finds both blocks by id when it runs.

export function filterHeadings(headings: HeadingTarget[], query: string): HeadingTarget[] {
  const q = query.trim().toLowerCase()
  return q ? headings.filter((h) => h.text.toLowerCase().includes(q)) : headings
}

export default function MoveToDialog({
  editor,
  target,
  onClose,
}: {
  editor: TiptapEditor
  target: BlockRef | null
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const headings = useMemo(() => {
    if (!target || editor.isDestroyed) return []
    const block = resolveBlock(editor.state.doc, target)
    return listHeadings(editor.state.doc).filter((h) => !block || h.pos !== block.pos)
    // Read once per opening: the dialog lists the headings as they were then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, editor])
  const shown = filterHeadings(headings, query)

  const close = () => {
    setQuery("")
    onClose()
  }

  const move = (heading: HeadingTarget) => {
    if (!target) return
    const moved = moveBlockUnder(editor, target, { id: heading.id, pos: heading.pos })
    close()
    if (!moved) toast.warning("The block or that heading isn't in the post any more")
    else if (!editor.isDestroyed) editor.commands.focus()
  }

  return (
    <Modal
      isOpen={!!target}
      onClose={close}
      size="small"
      title="Move to"
      description="The block moves right under the heading you pick."
      initialFocus={inputRef}
    >
      <div className="editor-move-to">
        <label className="editor-move-to__search">
          <span className="editor-move-to__sr">Search headings</span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder="Search headings"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown.length > 0) {
                e.preventDefault()
                move(shown[0])
              }
            }}
          />
        </label>
        {headings.length === 0 ? (
          <p className="editor-move-to__empty">This post has no other headings yet. Add one, then move blocks under it.</p>
        ) : shown.length === 0 ? (
          <p className="editor-move-to__empty">No heading matches “{query.trim()}”.</p>
        ) : (
          <ul className="editor-move-to__list" aria-label="Headings">
            {shown.map((heading) => (
              <li key={heading.id ?? heading.pos}>
                <button
                  type="button"
                  className="editor-move-to__option"
                  style={{ paddingLeft: `calc(var(--space-2) + ${Math.max(0, heading.level - 1) * 12}px)` }}
                  onClick={() => move(heading)}
                >
                  <span className="editor-move-to__level" aria-hidden="true">
                    H{heading.level}
                  </span>
                  <span className="editor-move-to__text">{heading.text || "Untitled heading"}</span>
                  <span className="editor-move-to__sr">, heading level {heading.level}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
