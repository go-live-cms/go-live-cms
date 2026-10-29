import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "prosemirror-state"
import { Decoration, DecorationSet } from "prosemirror-view"

type CursorAwarenessOpts = {
  awareness: any
  caretWidth?: number
  buildLabel?: (user: any) => string
  buildColor?: (user: any) => string
}

const key = new PluginKey("cursorAwareness")

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
export function createCaretElement(label: string, color: string, caretWidth = 2): HTMLSpanElement {
  const caret = document.createElement("span")
  caret.className = "collab-caret"
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
  // presence colour passes 4.5:1 with white), square bottom-left corner on the caret.
  labelEl.style.cssText = `
    position:absolute; left:-${caretWidth / 2}px; top:0; transform:translateY(-100%);
    background:${color}; color:#ffffff; font-family:var(--font-sans); font-size:11px; line-height:16px;
    font-weight:600; font-style:normal; letter-spacing:normal; text-transform:none; text-decoration:none;
    padding:0 6px; border-radius:4px 4px 4px 0; white-space:nowrap;
    pointer-events:none; user-select:none;
  `
  caret.appendChild(labelEl)
  return caret
}

export const CursorAwareness = Extension.create<CursorAwarenessOpts>({
  name: "cursorAwareness",

  addProseMirrorPlugins() {
    const awareness = this.options.awareness
    if (!awareness) return []

    const caretWidth = this.options.caretWidth ?? 2
    const buildLabel = this.options.buildLabel ?? ((u: any) => u?.name ?? "Guest")
    const buildColor = this.options.buildColor ?? ((u: any) => u?.color ?? "#3b82f6")

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

              if (to > from) {
                decos.push(
                  Decoration.inline(from, to, {
                    // A 13% tint of their colour (#341); the colours are hex (postCollab.ts).
                    style: `background: ${color}21;`,
                  })
                )
              }

              const caret = createCaretElement(label, color, caretWidth)
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

          return {
            destroy() {
              window.removeEventListener("blur", onBlur)
              awareness.off("change", onAwarenessChange)
              cancelAnimationFrame(raf)
              awareness.setLocalStateField("selection", null)
            },
            update() {
              cancelAnimationFrame(raf)
              raf = requestAnimationFrame(() => {
                pushSelection()
              })
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
