import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import type { Transaction } from "prosemirror-state"
import { blockIdSelector, commentCountLabel, docBlocks, isCommentableBlockId, openThreadCounts } from "@gl-admin/lib/comments"
import type { PostCommentsStore } from "@gl-admin/lib/commentsStore"
import { CommentIcon } from "./EditorTopBar"

// Block comments in the editor (#192): a marker in the right margin of every block with
// open threads (the count; click: the panel opens on them), a "Comment" button on the
// hovered block for anyone who may comment, read-only viewers included, and the block
// ids the doc has now, which the panel uses to tell orphans apart.
//
// It only reads the editor: no plugin, no transaction, no attribute on the doc (rule 7
// and the #315 design: threads aren't in the Yjs doc). The markers are an overlay placed
// from the blocks' DOM (`data-block-id`), re-measured after doc changes (remote ones
// included) and whenever the content box changes size (a panel opening, images loading).
// Doc changes are coalesced (REPORT_MS): typing doesn't walk the doc on every keystroke.

type Marker = { blockId: string; top: number; count: number }
type Rect = { blockId: string; top: number; height: number }

const BLOCK_SELECTOR = "[data-block-id]"
/** How long doc changes are collected before the blocks are reported and re-measured. */
export const REPORT_MS = 150

export default function BlockComments({ editor, store, children }: { editor: TiptapEditor; store: PostCommentsStore; children: ReactNode }) {
  const layerRef = useRef<HTMLDivElement>(null)
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [docVersion, setDocVersion] = useState(0)
  const [markers, setMarkers] = useState<Marker[]>([])
  const [active, setActive] = useState<Rect | null>(null)
  const [hovered, setHovered] = useState<Rect | null>(null)
  const canComment = !!snapshot.data?.can_comment

  // The doc's blocks, for the panel, after changes (anyone's), and a re-measure when the
  // content box changes size.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const report = () => {
      timer = null
      if (editor.isDestroyed) return
      store.setBlocks(docBlocks(editor.state.doc))
      setDocVersion((v) => v + 1)
    }
    report()
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged && !timer) timer = setTimeout(report, REPORT_MS)
    }
    editor.on("transaction", onTransaction)
    const resized = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => setDocVersion((v) => v + 1)) : null
    resized?.observe(editor.view.dom)
    return () => {
      editor.off("transaction", onTransaction)
      if (timer) clearTimeout(timer)
      resized?.disconnect()
      // Remounting (an access change) or gone: the panel mustn't take an empty doc for one
      // whose blocks were all deleted.
      store.forgetBlocks()
    }
  }, [editor, store])

  const measure = useCallback(
    (id: string): Rect | null => {
      const layer = layerRef.current
      if (!layer || editor.isDestroyed) return null
      const el = editor.view.dom.querySelector<HTMLElement>(blockIdSelector(id))
      if (!el) return null
      const base = layer.getBoundingClientRect()
      const box = el.getBoundingClientRect()
      return { blockId: id, top: box.top - base.top, height: box.height }
    },
    [editor]
  )

  const threads = snapshot.data?.threads
  const activeBlockId = snapshot.activeBlockId
  useLayoutEffect(() => {
    const place = () => {
      const counts = openThreadCounts(threads ?? [])
      const next: Marker[] = []
      for (const [blockId, count] of counts) {
        const rect = measure(blockId)
        if (rect) next.push({ blockId, top: rect.top, count })
      }
      setMarkers(next)
      setActive(activeBlockId ? measure(activeBlockId) : null)
    }
    place()
    window.addEventListener("resize", place)
    return () => window.removeEventListener("resize", place)
  }, [threads, activeBlockId, docVersion, measure])

  const onMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!canComment) return
    const target = e.target as HTMLElement | null
    if (target?.closest(".editor-comments-layer")) return
    const el = target?.closest<HTMLElement>(BLOCK_SELECTOR)
    const id = el && editor.view.dom.contains(el) ? el.getAttribute("data-block-id") : null
    if (!isCommentableBlockId(id)) {
      if (hovered) setHovered(null)
      return
    }
    if (hovered?.blockId !== id) setHovered(measure(id))
  }

  const markerFor = new Set(markers.map((m) => m.blockId))

  return (
    <div className="editor-comments" onMouseMove={onMouseMove} onMouseLeave={() => setHovered(null)}>
      <div ref={layerRef} className="editor-comments-layer" aria-label="Comments on blocks" role="group">
        {active && <div className="editor-comments-layer__active" style={{ top: active.top, height: active.height }} aria-hidden="true" />}
        {markers.map((marker) => (
          <button
            key={marker.blockId}
            type="button"
            className={`editor-comment-marker${marker.blockId === activeBlockId ? " is-active" : ""}`}
            style={{ top: marker.top }}
            aria-label={`${commentCountLabel(marker.count)} open on this block`}
            title={`${commentCountLabel(marker.count)} open`}
            onClick={() => store.focusBlock(marker.blockId, false)}
            onMouseEnter={() => store.setActiveBlock(marker.blockId)}
            onMouseLeave={() => store.setActiveBlock(null)}
          >
            <CommentIcon size={14} />
            <span>{marker.count}</span>
          </button>
        ))}
        {canComment && hovered && !markerFor.has(hovered.blockId) && (
          <button
            type="button"
            className="editor-comment-add"
            style={{ top: hovered.top }}
            aria-label="Comment on this block"
            title="Comment"
            onClick={() => store.focusBlock(hovered.blockId, true)}
          >
            <CommentIcon size={14} />
          </button>
        )}
      </div>
      {children}
    </div>
  )
}
