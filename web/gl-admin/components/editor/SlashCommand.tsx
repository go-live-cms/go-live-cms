import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from "react"
import { Extension } from "@tiptap/core"
import { ReactRenderer } from "@tiptap/react"
import { PluginKey } from "prosemirror-state"
import Suggestion from "./Suggestion"

export interface SlashCommandItem {
  title: string
  description: string
  icon: string
  command: ({ editor, range }: any) => void
  aliases?: string[]
}

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
    setSelectedIndex((selectedIndex + props.items.length - 1) % props.items.length)
  }

  const downHandler = () => {
    setSelectedIndex((selectedIndex + 1) % props.items.length)
  }

  const enterHandler = () => {
    selectItem(selectedIndex)
  }

  useEffect(() => setSelectedIndex(0), [props.items])

  useEffect(() => {
    const element = commandListRef.current
    if (element && selectedIndex >= 0) {
      const selectedElement = element.children[selectedIndex] as HTMLElement
      if (selectedElement) {
        selectedElement.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        })
      }
    }
  }, [selectedIndex])

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === "ArrowUp") {
        upHandler()
        return true
      }
      if (event.key === "ArrowDown") {
        downHandler()
        return true
      }
      if (event.key === "Enter") {
        enterHandler()
        return true
      }
      return false
    },
  }))

  if (props.items.length === 0) {
    return (
      <div className="slash-command-list">
        <div className="slash-command-item">
          <div className="content">
            <div className="title">No results found</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="slash-command-list" ref={commandListRef}>
      {props.items.map((item, index) => (
        <button
          className={`slash-command-item ${index === selectedIndex ? "selected" : ""}`}
          key={`${item.title}-${index}`}
          onClick={() => selectItem(index)}
          type="button"
        >
          <div className="icon">{item.icon}</div>
          <div className="content">
            <div className="title">{item.title}</div>
            <div className="description">{item.description}</div>
          </div>
        </button>
      ))}
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
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ]
  },
})

export default SlashCommandExtension
