import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect } from "vitest"
import type { BlockDocV1 } from "../blocks-spec"
import { diffBlockDocs } from "./blockDiff"
import VersionDiff from "../../components/editor/ui/VersionDiff"

// History's "Highlight changes" (#355) with the #419 blocks: a to-do list is a list (its
// items matched by id, a ticked item is a change), a callout's Type and a pull quote's
// Citation are attributes with their own labels.

const CALLOUT = "blk-callout-00001"
const PULL = "blk-pullquote-001"
const TODO = "blk-todo-list-001"
const T1 = "blk-todo-item-001"
const T2 = "blk-todo-item-002"

function doc({ tone = "info", cite = "Ana", checked = false, second = "two" } = {}): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [CALLOUT, PULL, TODO],
    blocks: {
      [CALLOUT]: { id: CALLOUT, type: "callout", version: 1, attrs: { tone, text: "Note" } },
      [PULL]: { id: PULL, type: "pull_quote", version: 1, attrs: { cite, text: "Set large" } },
      [TODO]: { id: TODO, type: "todo_list", version: 1, attrs: {}, children: [T1, T2] },
      [T1]: { id: T1, type: "todo_item", version: 1, attrs: { checked, text: "one" } },
      [T2]: { id: T2, type: "todo_item", version: 1, attrs: { checked: false, text: second } },
    },
  } as BlockDocV1
}

describe("blockDiff with callout, pull quote and to-do list (#419)", () => {
  it("unchanged blocks are the same", () => {
    const diff = diffBlockDocs(doc(), doc())
    expect(diff.entries.map((e) => e.status)).toEqual(["same", "same", "same"])
  })

  it("a callout's tone and a pull quote's citation are named attributes", () => {
    const diff = diffBlockDocs(doc({ tone: "warning", cite: "Ana" }), doc({ tone: "danger", cite: "Bo" }))
    expect(diff.entries[0].attrs).toEqual([{ key: "tone", label: "Type", version: "Warning", working: "Danger" }])
    expect(diff.entries[1].attrs).toEqual([{ key: "cite", label: "Citation", version: "Ana", working: "Bo" }])
  })

  it("a to-do list compares its items by id: a ticked item and an edited one are changes", () => {
    const version = doc({ checked: true })
    const working = doc({ checked: false, second: "two!" })
    const diff = diffBlockDocs(version, working)
    const list = diff.entries[2]
    expect(list.status).toBe("changed")
    expect(list.list!.items.map((i) => [i.id, i.status])).toEqual([
      [T1, "changed"],
      [T2, "changed"],
    ])
    expect(list.list!.items[0].attrs).toEqual([{ key: "checked", label: "Done", version: "Yes", working: "No" }])
    expect(list.list!.items[1].attrs).toBeUndefined()
    const html = renderToStaticMarkup(<VersionDiff diff={diff} version={version} working={working} />)
    expect(html).toContain("Done:")
  })

  it("a bulleted list turned into a to-do list says so", () => {
    const working = doc()
    working.blocks[TODO] = { ...working.blocks[TODO], type: "bullet_list" }
    for (const id of [T1, T2]) working.blocks[id] = { id, type: "list_item", version: 1, attrs: { text: (working.blocks[id].attrs as any).text } }
    const diff = diffBlockDocs(doc(), working)
    expect(diff.entries[2].attrs).toEqual([{ key: "listType", label: "List type", version: "To-do", working: "Bulleted" }])
  })
})
