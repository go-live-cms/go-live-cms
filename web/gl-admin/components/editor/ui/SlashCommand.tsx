import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from "react"
import { Extension } from "@tiptap/core"
import { ReactRenderer } from "@tiptap/react"
import { PluginKey } from "prosemirror-state"
import { Suggestion } from "../utils/suggestion"

export interface SlashCommandItem {
  title: string
  description: string
  icon: string
  command: ({ editor, range }: any) => void
  aliases?: string[]
  hint?: string
  group?: "media"
}

const GROUP_LABELS = { basic: "Basic blocks", media: "Media" } as const

export const SlashCommandList = forwardRef<
  any,
  {
    items: SlashCommandItem[]
    command: (item: SlashCommandItem) => void
    editor: any
  }
>((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const commandListRef = useRef<HTMLDivElement>(null)

  const selectItem = (index: number) => {
    const item = props.items[index]
    if (item) {
      props.command(item)
    }
  }

  const upHandler = () => {
    setSelectedIndex((prev) => {
      const newIndex = prev > 0 ? prev - 1 : props.items.length - 1
      return newIndex
    })
  }

  const downHandler = () => {
    setSelectedIndex((prev) => {
      const newIndex = prev < props.items.length - 1 ? prev + 1 : 0
      return newIndex
    })
  }

  const enterHandler = () => {
    selectItem(selectedIndex)
  }

  useEffect(() => {
    setSelectedIndex(0)
  }, [props.items])

  useEffect(() => {
    const selectedElement = commandListRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
    selectedElement?.scrollIntoView?.({ block: "nearest" })
  }, [selectedIndex])

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === "ArrowUp") {
        event.preventDefault()
        event.stopPropagation()
        upHandler()
        return true
      }
      if (event.key === "ArrowDown") {
        event.preventDefault()
        event.stopPropagation()
        downHandler()
        return true
      }
      if (event.key === "Enter") {
        event.preventDefault()
        event.stopPropagation()
        enterHandler()
        return true
      }
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        return true
      }
      return false
    },
  }))

  if (props.items.length === 0) {
    return (
      <div className="slash-command-list">
        <div className="slash-command-empty">No blocks match</div>
      </div>
    )
  }

  // Sections in the design's order; items keep one flat index for the keyboard.
  const sections = (["basic", "media"] as const)
    .map((group) => ({
      group,
      items: props.items.map((item, index) => ({ item, index })).filter(({ item }) => (item.group ?? "basic") === group),
    }))
    .filter((s) => s.items.length > 0)

  return (
    <div className="slash-command-list" ref={commandListRef} role="listbox" aria-label="Insert block">
      {sections.map((section, i) => (
        <div key={section.group} role="group" aria-label={GROUP_LABELS[section.group]}>
          {i > 0 && <div className="slash-command-separator" aria-hidden="true" />}
          <div className="slash-command-group" aria-hidden="true">
            {GROUP_LABELS[section.group]}
          </div>
          {section.items.map(({ item, index }) => (
            <button
              className={`slash-command-item ${index === selectedIndex ? "selected" : ""}`}
              key={`${item.title}-${index}`}
              data-index={index}
              role="option"
              aria-selected={index === selectedIndex}
              title={item.description}
              onClick={() => selectItem(index)}
              type="button"
            >
              <span className="icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="title">{item.title}</span>
              {item.hint && <span className="hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      ))}
      <div className="slash-command-footer" aria-hidden="true">
        <span>↑↓ to move</span>
        <span>↵ to insert</span>
        <span>esc to close</span>
      </div>
    </div>
  )
})

SlashCommandList.displayName = "SlashCommandList"

export const SlashCommandExtension = Extension.create({
  name: "slashCommand",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        pluginKey: new PluginKey("slashCommand"),
        command: ({ editor, range, props }: any) => {
          props.command({ editor, range })
        },
        items: ({ query }: { query: string }) => [],
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
