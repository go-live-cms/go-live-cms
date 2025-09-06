import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "prosemirror-state"
import { Decoration, DecorationSet } from "prosemirror-view"

export interface SuggestionOptions {
  char: string
  pluginKey: PluginKey
  allowSpaces: boolean
  allowedPrefixes: string[] | null
  startOfLine: boolean
  decorationTag: string
  decorationClass: string
  command: (props: { editor: any; range: Range; props: any }) => void
  items: (props: { query: string; editor: any }) => any[]
  render: () => {
    onStart?: (props: any) => void
    onUpdate?: (props: any) => void
    onKeyDown?: (props: any) => boolean
    onExit?: (props: any) => void
  }
  allow?: (props: { editor: any; state: any; range: Range }) => boolean
}

export interface Range {
  from: number
  to: number
}

export interface SuggestionProps {
  editor: any
  range: Range
  query: string
  text: string
  items: any[]
  command: (item: any) => void
  decorationNode: Element | null
  clientRect?: () => DOMRect | null
}

function findSuggestionMatch({
  editor,
  state,
  from,
  to,
  char,
  allow,
}: {
  editor: any
  state: any
  from: number
  to: number
  char: string
  allow?: (props: { editor: any; state: any; range: Range }) => boolean
}) {
  const { doc } = state

  if (from !== to) {
    return null
  }

  const $pos = doc.resolve(from)
  const textBefore = $pos.parent.textBetween(Math.max(0, $pos.parentOffset - 100), $pos.parentOffset, null, "\ufffc")

  const match = textBefore.match(new RegExp(`(^|\\s)(\\${char}([^\\s]*))$`))

  if (!match) {
    return null
  }

  const matchStart = match.index || 0
  const matchLength = match[2].length
  const query = match[3] || ""
  const text = match[2]

  // Make sure we actually have the trigger character
  if (!text.includes(char)) {
    return null
  }

  const from_pos = $pos.start() + matchStart + (match[1]?.length || 0)
  const to_pos = from_pos + matchLength

  const range = {
    from: from_pos,
    to: to_pos,
  }

  if (allow && !allow({ editor, state, range })) {
    return null
  }

  return {
    range,
    query,
    text,
  }
}

export const Suggestion = Extension.create<SuggestionOptions>({
  name: "suggestion",

  addOptions() {
    return {
      char: "@",
      pluginKey: new PluginKey("suggestion"),
      allowSpaces: false,
      allowedPrefixes: [" "],
      startOfLine: false,
      decorationTag: "span",
      decorationClass: "suggestion",
      command: () => null,
      items: () => [],
      render: () => ({}),
      allow: () => true,
    }
  },

  addProseMirrorPlugins() {
    const options = this.options
    const editor = this.editor

    return [
      new Plugin({
        key: options.pluginKey,
        props: {
          handleKeyDown: (view, event) => {
            const { state } = view
            const { selection } = state
            const { ranges } = selection
            const from = Math.min(...ranges.map((range) => range.$from.pos))
            const to = Math.max(...ranges.map((range) => range.$to.pos))

            const suggestionMatch = findSuggestionMatch({
              editor,
              state,
              from,
              to,
              char: options.char,
              allow: options.allow,
            })

            if (!suggestionMatch) {
              return false
            }

            const handled = options.render().onKeyDown?.({
              view,
              event,
              range: suggestionMatch.range,
              query: suggestionMatch.query,
            })

            if (handled) {
              return true
            }

            return false
          },
        },
        view: () => {
          let currentRange: any = null
          let hasStarted = false

          const cleanup = () => {
            if (hasStarted) {
              options.render().onExit?.({ editor })
              hasStarted = false
            }
            currentRange = null
          }

          return {
            update: (view, prevState) => {
              const { state, composing } = view
              const { selection } = state
              const { ranges } = selection
              const from = Math.min(...ranges.map((range) => range.$from.pos))
              const to = Math.max(...ranges.map((range) => range.$to.pos))

              if (composing) return

              const suggestionMatch = findSuggestionMatch({
                editor,
                state,
                from,
                to,
                char: options.char,
                allow: options.allow,
              })

              if (!suggestionMatch) {
                if (hasStarted) {
                  cleanup()
                }
                return
              }

              const { range, query, text } = suggestionMatch
              const items = options.items({ editor, query })

              const props: SuggestionProps = {
                editor,
                range,
                query,
                text,
                items,
                command: (item: any) => {
                  options.command({ editor, range, props: item })
                  cleanup()
                },
                decorationNode: null,
                clientRect: () => {
                  try {
                    const start = view.coordsAtPos(range.from)
                    return new DOMRect(start.left, start.top, 0, start.bottom - start.top)
                  } catch {
                    return null
                  }
                },
              }

              if (!hasStarted) {
                hasStarted = true
                currentRange = range
                options.render().onStart?.(props)
              } else if (
                currentRange &&
                Math.abs(currentRange.from - range.from) <= 2 &&
                Math.abs(currentRange.to - range.to) <= 2
              ) {
                currentRange = range
                options.render().onUpdate?.(props)
              } else {
                cleanup()
                hasStarted = true
                currentRange = range
                options.render().onStart?.(props)
              }
            },

            destroy: cleanup,
          }
        },

        state: {
          init() {
            return DecorationSet.empty
          },

          apply: (transaction, decorationSet, oldState, newState) => {
            const { doc, selection } = newState
            const { ranges } = selection
            const from = Math.min(...ranges.map((range) => range.$from.pos))
            const to = Math.max(...ranges.map((range) => range.$to.pos))

            const suggestionMatch = findSuggestionMatch({
              editor,
              state: newState,
              from,
              to,
              char: options.char,
              allow: options.allow,
            })

            if (!suggestionMatch) {
              return DecorationSet.empty
            }

            const { range } = suggestionMatch
            const decoration = Decoration.inline(range.from, range.to, {
              class: options.decorationClass,
            })

            return DecorationSet.create(doc, [decoration])
          },
        },
      }),
    ]
  },
})

export default Suggestion
