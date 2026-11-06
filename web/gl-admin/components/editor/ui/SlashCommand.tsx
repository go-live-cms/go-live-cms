import { forwardRef, useEffect, useImperativeHandle } from "react"
import { Extension, type Editor } from "@tiptap/core"
import { PluginKey } from "prosemirror-state"
import { Suggestion } from "../utils/suggestion"
import type { CatalogEntry, InsertRange } from "../blocks/catalog"
import { InsertMenuFooter, InsertMenuList, optionId, useInsertMenu } from "./InsertMenu"

// The slash menu (#415, "Inserting blocks"): "/" on an empty line or after a space opens the
// block catalog; what follows the slash searches it. Focus stays in the text, so the
// editor's element points at the list (aria-controls) and the highlighted option
// (aria-activedescendant) while it's open. ↑↓ move across groups, ↵ inserts, Esc closes
// and keeps the typed text (slashCommandManager), and with nothing matching ↵ and the
// arrows are the editor's again.

export const SLASH_MENU_ID = "gl-slash-menu"

export interface SlashCommandListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

interface Props {
  items: CatalogEntry[]
  query: string
  command: (entry: CatalogEntry) => void
  editor: Editor
}

export const SlashCommandList = forwardRef<SlashCommandListRef, Props>(function SlashCommandList({ items, query, command, editor }, ref) {
  const menu = useInsertMenu(items, query)

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        if (!menu.move(event.key)) return false
        event.preventDefault()
        return true
      }
      if (event.key === "Enter") {
        if (!menu.activeEntry) return false
        event.preventDefault()
        command(menu.activeEntry)
        return true
      }
      return false
    },
  }))

  // The text is the combobox: point it at the list and the active option.
  useEffect(() => {
    if (editor.isDestroyed) return
    const dom = editor.view.dom
    if (menu.active >= 0) {
      dom.setAttribute("aria-controls", `${SLASH_MENU_ID}-list`)
      dom.setAttribute("aria-activedescendant", optionId(SLASH_MENU_ID, menu.active))
    } else {
      dom.removeAttribute("aria-controls")
      dom.removeAttribute("aria-activedescendant")
    }
  }, [editor, menu.active, menu.options])
  useEffect(
    () => () => {
      if (editor.isDestroyed) return
      editor.view.dom.removeAttribute("aria-controls")
      editor.view.dom.removeAttribute("aria-activedescendant")
    },
    [editor]
  )

  return (
    <div className="editor-insert slash-command-list">
      <InsertMenuList menu={menu} query={query} idPrefix={SLASH_MENU_ID} onPick={command} />
      <InsertMenuFooter
        menu={menu}
        query={query}
        idle={["↑↓ to move", "↵ to insert", "esc to close"]}
        noMatch={`esc closes the menu and keeps “/${query}” as text`}
      />
    </div>
  )
})

export const SlashCommandExtension = Extension.create({
  name: "slashCommand",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        pluginKey: new PluginKey("slashCommand"),
        command: ({ editor, range, props }: { editor: Editor; range: InsertRange; props: CatalogEntry }) => {
          props.insert(editor, range)
        },
        items: () => [] as CatalogEntry[],
        render: () => ({}),
      },
    }
  },

  addExtensions() {
    return [
      Suggestion.configure({
        ...this.options.suggestion,
      }),
    ]
  },
})

export default SlashCommandExtension
