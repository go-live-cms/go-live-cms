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
          init: () => DecorationSet.empty,
          apply(tr, old) {
            
            if (tr.docChanged) return old.map(tr.mapping, tr.doc)
            return old
          },
        },
        view: (view) => {
          const render = () => {
            const states = awareness.getStates()
            const me = awareness.clientID
            const decos: Decoration[] = []

            for (const [clientId, s] of states.entries()) {
              if (clientId === me) continue
              const user = s?.user || {}
              const sel = s?.selection
              if (!sel) continue

              const { anchor, head } = sel
              const a = Math.max(1, Math.min(anchor ?? 1, view.state.doc.content.size))
              const h = Math.max(1, Math.min(head ?? a, view.state.doc.content.size))
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
                background:${color}; transform: translateY(2px);
              `

              const labelEl = document.createElement("span")
              labelEl.className = "collab-caret-label"
              labelEl.textContent = label
              labelEl.style.cssText = `
                position:absolute; transform: translate(-50%, -110%);
                background:${color}; color:white; font-size:12px; line-height:1;
                padding:2px 6px; border-radius:4px; white-space:nowrap;
                box-shadow:0 1px 2px rgba(0,0,0,.15);
              `

              const wrap = document.createElement("span")
              wrap.style.position = "relative"
              wrap.appendChild(caret)
              wrap.appendChild(labelEl)

              decos.push(Decoration.widget(h, wrap, { key: `caret-${clientId}` }))
            }

            const decoSet = DecorationSet.create(view.state.doc, decos)
            view.updateState(view.state.reconfigure({ plugins: view.state.plugins }))
            ;(view as any).dispatch(view.state.tr.setMeta(key, { decoSet }))
          }

          const onChange = () => {
            
            const sel = view.state.selection
            awareness.setLocalStateField("selection", {
              anchor: sel.anchor,
              head: sel.head,
            })

            
            render()
          }

          
          onChange()

          awareness.on("change", onChange)
          return {
            destroy() {
              awareness.off("change", onChange)
            },
            update() {
              
              const sel = view.state.selection
              awareness.setLocalStateField("selection", {
                anchor: sel.anchor,
                head: sel.head,
              })
            },
          }
        },
        props: {
          decorations(state) {
            const pluginState = key.getState(state) as any
            return pluginState?.decoSet ?? null
          },
        },
      }),
    ]
  },
})
