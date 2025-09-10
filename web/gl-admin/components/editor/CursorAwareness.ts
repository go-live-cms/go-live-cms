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
                    style: `background: ${color}22; border-bottom: 1px solid ${color}55;`,
                  })
                )
              }

              const caret = document.createElement("span")
              caret.className = "collab-caret"
              caret.style.cssText = `
                display:inline-block;width:${caretWidth}px;height:1.2em;
                background:${color}; transform: translateY(2px); pointer-events:none;
              `

              const labelEl = document.createElement("span")
              labelEl.className = "collab-caret-label"
              labelEl.textContent = label
              labelEl.style.cssText = `
                position:absolute; transform: translate(-50%, -110%);
                background:${color}; color:white; font-size:12px; line-height:1;
                padding:2px 6px; border-radius:4px; white-space:nowrap;
                box-shadow:0 1px 2px rgba(0,0,0,.15); pointer-events:none;
              `

              const wrap = document.createElement("span")
              wrap.style.position = "relative"
              wrap.appendChild(caret)
              wrap.appendChild(labelEl)

              decos.push(Decoration.widget(h, wrap, { key: `caret-${clientId}` }))
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

          pushSelection()
          render()

          awareness.on("change", onAwarenessChange)

          return {
            destroy() {
              awareness.off("change", onAwarenessChange)
              cancelAnimationFrame(raf)
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
