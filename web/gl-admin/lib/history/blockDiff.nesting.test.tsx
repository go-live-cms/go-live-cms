import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect } from "vitest"
import type { BlockDocV1 } from "../blocks-spec"
import { diffBlockDocs } from "./blockDiff"
import VersionDiff from "../../components/editor/ui/VersionDiff"

// History's "Highlight changes" (#355) with containers (#414): a group's children are
// matched by id like the top level, so an edit inside a group shows on that block.

const G = "blk-group-000001"
const A = "blk-para-0000001"
const B = "blk-para-0000002"
const C = "blk-para-0000003"

const doc = (children: string[], texts: Record<string, string>, attrs: Record<string, unknown> = {}): BlockDocV1 => ({
  doc_version: 1,
  blocks_order: [G],
  blocks: {
    [G]: { id: G, type: "group", version: 1, attrs, children },
    ...Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, { id, type: "paragraph", version: 1, attrs: { text } }])),
  },
})

describe("blockDiff with containers (#414)", () => {
  it("an unchanged group is the same", () => {
    const d = doc([A, B], { [A]: "one", [B]: "two" })
    const diff = diffBlockDocs(d, d)
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0].status).toBe("same")
    expect(diff.entries[0].children!.map((c) => c.status)).toEqual(["same", "same"])
  })

  it("compares the group's children by id: edited, added, removed, moved", () => {
    const version = doc([A, B, C], { [A]: "one", [B]: "two", [C]: "three" })
    const working = doc([C, A, "blk-para-0000004"], { [A]: "one!", [C]: "three", "blk-para-0000004": "four" })
    const diff = diffBlockDocs(version, working)
    const group = diff.entries[0]
    expect(group.status).toBe("changed")
    const byId = Object.fromEntries(group.children!.map((c) => [c.id, c]))
    expect(byId[A].status).toBe("changed")
    expect(byId[B].status).toBe("version")
    expect(byId["blk-para-0000004"].status).toBe("working")
    expect(byId[A].moved || byId[C].moved).toBe(true)
    expect(diff.summary.changed).toBe(1)
  })

  it("shows the group's width and background as attribute changes", () => {
    const version = doc([A], { [A]: "one" }, { style: "tinted" })
    const working = doc([A], { [A]: "one" }, { align: "full" })
    const group = diffBlockDocs(version, working).entries[0]
    expect(group.status).toBe("changed")
    expect(group.attrs).toEqual([
      { key: "align", label: "Width", version: "Content", working: "Full width" },
      { key: "style", label: "Background", version: "Tinted", working: "None" },
    ])
  })

  it("VersionDiff renders the nested blocks with their own diff", () => {
    const version = doc([A, B], { [A]: "one", [B]: "two" })
    const working = doc([A], { [A]: "one more" })
    const html = renderToStaticMarkup(
      <VersionDiff diff={diffBlockDocs(version, working)} version={version} working={working} />,
    )
    expect(html).toContain('class="version-diff__container"')
    expect(html).toContain(`data-block-id="${A}"`)
    expect(html).toContain(`data-block-id="${B}"`)
    expect(html).toContain("<del")
  })
})
