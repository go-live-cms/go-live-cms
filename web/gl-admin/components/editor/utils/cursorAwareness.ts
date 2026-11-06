import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "prosemirror-state"
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view"
import { isEditorBlock } from "./blockTree"

type CursorAwarenessOpts = {
  awareness: any
  caretWidth?: number
  buildLabel?: (user: any) => string
  buildColor?: (user: any) => string
}

const key = new PluginKey("cursorAwareness")

const DEFAULT_COLOR = "#3b82f6"

/**
 * A presence colour, or the default. Colours come from other clients' awareness, which any
 * collaborator can set, and end up in a style: only a hex colour (what postCollab.ts sends)
 * gets through.
 */
export function safeCaretColor(color: unknown): string {
  return typeof color === "string" && /^#[0-9a-f]{3,8}$/i.test(color) ? color : DEFAULT_COLOR
}

/**
 * Whether a caret's name label, drawn to the right of the caret, would overflow the right
 * edge of what holds it (its container block, else the editor): then it flips to the
 * caret's left (#417, "Others in nested layouts": "Near a right edge the label flips").
 */
export function labelFlips(caretLeft: number, labelWidth: number, boundsRight: number): boolean {
  return caretLeft + labelWidth > boundsRight
}

type Box = { left: number; right: number; top: number }

/** How many label heights up a label goes so it doesn't cover one placed before it (stacking). */
export function stackLevel(box: Box, placed: (Box & { level: number })[], lineTolerance = 4): number {
  let level = 0
  for (;;) {
    const clash = placed.some(
      (other) => other.level === level && Math.abs(other.top - box.top) <= lineTolerance && box.left < other.right && other.left < box.right
    )
    if (!clash) return level
    level++
  }
}

/** The element a caret's label must stay inside: its container block (`data-collab-bounds`), else the editor. */
function boundsOf(caret: HTMLElement, root: HTMLElement): HTMLElement {
  const bounds = caret.closest<HTMLElement>("[data-collab-bounds]")
  return bounds && root.contains(bounds) ? bounds : root
}

/**
 * Places every remote caret's label after a render (#417): flipped to the caret's left when
 * it would overflow its container's or the editor's right edge, and raised above another
 * label on the same spot ("Two carets in one place stack their labels"). Only the labels'
 * own styles change: the carets are widget decorations, whose DOM ProseMirror leaves alone.
 */
export function placeCaretLabels(root: HTMLElement) {
  const placed: (Box & { level: number })[] = []
  for (const caret of Array.from(root.querySelectorAll<HTMLElement>(".collab-caret"))) {
    const label = caret.querySelector<HTMLElement>(".collab-caret-label")
    if (!label) continue
    const caretBox = caret.getBoundingClientRect()
    const width = label.offsetWidth || label.getBoundingClientRect().width
    const flip = labelFlips(caretBox.left, width, boundsOf(caret, root).getBoundingClientRect().right)
    const box = flip
      ? { left: caretBox.left - width, right: caretBox.left, top: caretBox.top }
      : { left: caretBox.left, right: caretBox.left + width, top: caretBox.top }
    const level = stackLevel(box, placed)
    placed.push({ ...box, level })
    label.classList.toggle("is-flipped", flip)
    label.style.left = flip ? "auto" : "-1px"
    label.style.right = flip ? "-1px" : "auto"
    label.style.borderRadius = flip ? "4px 4px 0 4px" : "4px 4px 4px 0"
    label.style.transform = level === 0 ? "translateY(-100%)" : `translateY(calc(-100% * ${level + 1} - ${2 * level}px))`
  }
}

/**
 * Whether a remote selection [from, to] is exactly one block (they pressed Esc, or dragged
 * it): shown as an outline in their colour with their name on its top edge, not as a tint.
 */
function selectedBlockAt(doc: import("prosemirror-model").Node, from: number, to: number): boolean {
  const node = doc.nodeAt(from)
  if (!node || node.isInline || from + node.nodeSize !== to) return false
  const $from = doc.resolve(from)
  return isEditorBlock(node, $from.parent)
}

/**
 * A remote user's caret + name label, as a widget decoration's DOM.
 *
 * It must never change the line's height (#305). Like y-prosemirror's caret: a zero-width
 * inline span drawn with a border (negative margins keep the text from shifting), holding
 * a word joiner so it takes the line's own height, with the label absolutely positioned
 * inside it, out of the flow and just above the caret. (The old 1.2em inline-block grew
 * the line box; the label resets typography it would otherwise inherit from a heading or
 * an emphasized run.)
 */
export function createCaretElement(label: string, color: string, caretWidth = 2, clientId?: number): HTMLSpanElement {
  const caret = document.createElement("span")
  caret.className = "collab-caret"
  // Presence "jump to cursor" (#356) scrolls to the caret of this awareness client.
  if (clientId !== undefined) caret.dataset.clientId = String(clientId)
  caret.style.cssText = `
    position:relative; border-left:${caretWidth}px solid ${color};
    margin-left:-${caretWidth / 2}px; margin-right:-${caretWidth / 2}px;
    word-break:normal; pointer-events:none;
  `
  caret.appendChild(document.createTextNode(String.fromCharCode(0x2060))) // word joiner: zero width, but gives the span line height

  const labelEl = document.createElement("span")
  labelEl.className = "collab-caret-label"
  labelEl.textContent = label
  // The design's name label (#341): 11px semibold white on the person's colour (every
  // presence colour passes 4.5:1 with white), square bottom-left corner on the caret, and
  // a 2px ring in the page colour that keeps it apart from a tinted group (#417).
  // `placeCaretLabels` flips it to the left at a right edge and stacks it over another.
  labelEl.style.cssText = `
    position:absolute; left:-${caretWidth / 2}px; top:0; transform:translateY(-100%);
    background:${color}; color:#ffffff; font-family:var(--font-sans); font-size:11px; line-height:16px;
    font-weight:600; font-style:normal; letter-spacing:normal; text-transform:none; text-decoration:none;
    padding:0 6px; border-radius:4px 4px 4px 0; white-space:nowrap;
    box-shadow:0 0 0 2px var(--background); z-index:1;
    pointer-events:none; user-select:none;
  `
  caret.appendChild(labelEl)
  return caret
}

/**
 * Presence "jump to cursor" (#356): scrolls to the caret this extension drew for the first
 * of `clientIds` (one person's tabs) that has one, else to the position its awareness
 * state names. Read-only: it moves the page, never this user's selection. False when none
 * of them has a caret in the text (a window that lost focus clears its caret).
 */
export function scrollToCollaborator(view: EditorView, awareness: any, clientIds: number[]): boolean {
  // The editor isn't on screen (History shows a version over it, the bound editor stays
  // mounted but hidden): there's nothing to scroll to.
  if (!view.dom.isConnected || view.dom.closest("[hidden]")) return false
  const smooth = typeof window.matchMedia === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const options: ScrollIntoViewOptions = { block: "center", behavior: smooth ? "smooth" : "auto" }
  for (const id of clientIds) {
    const caret = view.dom.querySelector<HTMLElement>(`.collab-caret[data-client-id="${Number(id)}"]`)
    if (caret) {
      caret.scrollIntoView?.(options)
      return true
    }
  }
  const states = awareness?.getStates?.() as Map<number, any> | undefined
  for (const id of clientIds) {
    const head = states?.get(id)?.selection?.head
    if (typeof head !== "number") continue
    try {
      const { node } = view.domAtPos(Math.max(0, Math.min(head, view.state.doc.content.size)))
      const element = node instanceof Element ? node : node.parentElement
      if (!element) continue
      element.scrollIntoView?.(options)
      return true
    } catch {
      // A stale position (the doc changed under it): no caret to go to.
    }
  }
  return false
}

export const CursorAwareness = Extension.create<CursorAwarenessOpts>({
  name: "cursorAwareness",

  addProseMirrorPlugins() {
    const awareness = this.options.awareness
    if (!awareness) return []

    const caretWidth = this.options.caretWidth ?? 2
    const buildLabel = this.options.buildLabel ?? ((u: any) => u?.name ?? "Guest")
    const pickColor = this.options.buildColor ?? ((u: any) => u?.color)
    const buildColor = (user: any) => safeCaretColor(pickColor(user))

    return [
      new Plugin({
        key,
        state: {
          init: () => ({ decoSet: DecorationSet.empty }),
          apply(tr, old) {
            const meta = tr.getMeta(key)
            if (meta?.decoSet) {
              return { decoSet: meta.decoSet }
            }

            if (tr.docChanged) {
              return { decoSet: old.decoSet.map(tr.mapping, tr.doc) }
            }
            return old
          },
        },
        view: (view) => {
          let raf = 0
          let lastSel = { anchor: -1, head: -1 }

          const buildDecos = () => {
            const states = awareness.getStates()
            const me = awareness.clientID
            const decos: Decoration[] = []
            const size = view.state.doc.content.size

            if (size === 0) {
              return DecorationSet.empty
            }

            for (const [clientId, s] of states.entries()) {
              if (clientId === me) continue
              const user = s?.user || {}
              const sel = s?.selection
              if (!sel) continue

              const a = Math.max(0, Math.min(sel.anchor ?? 0, size))
              const h = Math.max(0, Math.min(sel.head ?? a, size))
              const from = Math.min(a, h)
              const to = Math.max(a, h)
              const color = buildColor(user)
              const label = buildLabel(user)

              if (to > from && selectedBlockAt(view.state.doc, from, to)) {
                // A block they selected (#417): their colour as an outline, inside this
                // user's own, with their name on its top edge (CSS: .collab-block-selection).
                decos.push(
                  Decoration.node(from, to, {
                    class: "collab-block-selection",
                    style: `--collab-color: ${color};`,
                    "data-collab-name": label,
                  })
                )
                continue
              }

              if (to > from) {
                decos.push(
                  Decoration.inline(from, to, {
                    // A 20% tint of their colour (#341, #417: text under it keeps its
                    // contrast on white, on dark and on a group's tint); hex colours only.
                    style: `background: ${color}33;`,
                  })
                )
              }

              const caret = createCaretElement(label, color, caretWidth, clientId)
              decos.push(Decoration.widget(h, caret, { key: `caret-${clientId}`, side: 10 }))
            }

            return DecorationSet.create(view.state.doc, decos)
          }

          const render = () => {
            const decoSet = buildDecos()
            const tr = view.state.tr.setMeta(key, { decoSet })
            view.dispatch(tr)
          }

          const pushSelection = () => {
            const { anchor, head } = view.state.selection
            if (anchor === lastSel.anchor && head === lastSel.head) return
            lastSel = { anchor, head }
            awareness.setLocalStateField("selection", lastSel)
          }

          const onAwarenessChange = () => {
            render()
          }

          const onBlur = () => awareness.setLocalStateField("selection", null)

          pushSelection()
          render()

          window.addEventListener("blur", onBlur)
          awareness.on("change", onAwarenessChange)

          // Labels are placed once the carets are on screen (#417: flip, stack).
          let labelsRaf = 0
          const placeLabels = () => {
            cancelAnimationFrame(labelsRaf)
            labelsRaf = requestAnimationFrame(() => {
              if (view.dom.isConnected) placeCaretLabels(view.dom)
            })
          }

          return {
            destroy() {
              window.removeEventListener("blur", onBlur)
              awareness.off("change", onAwarenessChange)
              cancelAnimationFrame(raf)
              cancelAnimationFrame(labelsRaf)
              awareness.setLocalStateField("selection", null)
            },
            update() {
              cancelAnimationFrame(raf)
              raf = requestAnimationFrame(() => {
                pushSelection()
              })
              placeLabels()
            },
          }
        },
        props: {
          decorations(state) {
            const pluginState = key.getState(state) as any
            return pluginState?.decoSet ?? DecorationSet.empty
          },
        },
      }),
    ]
  },
})
