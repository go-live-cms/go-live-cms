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

describe("blockDiff with cover and media & text (#427)", () => {
  const CV = "blk-cover-000001"
  const P = "blk-para-0000001"
  const container = (type: string, attrs: Record<string, unknown>, text = "on top"): BlockDocV1 =>
    ({
      doc_version: 1,
      blocks_order: [CV],
      blocks: {
        [CV]: { id: CV, type, version: 1, attrs, children: [P] },
        [P]: { id: P, type: "paragraph", version: 1, attrs: { text } },
      },
    }) as BlockDocV1
  const changed = (v: BlockDocV1, w: BlockDocV1) => Object.fromEntries((diffBlockDocs(v, w).entries[0].attrs ?? []).map((a) => [a.key, [a.version, a.working]]))

  it("identical docs are the same; a text edit shows on its block, inside", () => {
    const a = container("cover", { mediaId: 1, overlay: 55 })
    expect(diffBlockDocs(a, a).entries[0].status).toBe("same")
    const edited = diffBlockDocs(a, container("cover", { mediaId: 1, overlay: 55 }, "on top now"))
    expect(edited.entries[0].children![0].status).toBe("changed")
  })

  it("names a cover's image, alt text, focal point, overlay and width", () => {
    const v = container("cover", { mediaId: 1, alt: "A", decorative: true, overlay: 55 })
    const w = container("cover", { mediaId: 2, alt: "B", decorative: false, focal: { x: 10, y: 90 }, overlay: 30, align: "wide" })
    expect(changed(v, w)).toEqual({
      file: ["Media #1", "Media #2"],
      alt: ["A", "B"],
      decorative: ["On", "Off"],
      focal: ["From the image", "10%, 90%"],
      overlay: ["55%", "30%"],
      align: ["Content", "Wide"],
    })
  })

  it("names media & text's position", () => {
    expect(changed(container("media_text", { mediaId: 1 }), container("media_text", { mediaId: 1, position: "right" }))).toEqual({ position: ["Left", "Right"] })
  })
})

describe("blockDiff with a details (#421)", () => {
  const D = "blk-details-0001"
  const details = (summary: string, attrs: Record<string, unknown> = {}, text = "answer"): BlockDocV1 => ({
    doc_version: 1,
    blocks_order: [D],
    blocks: {
      [D]: { id: D, type: "details", version: 1, attrs: { ...(summary ? { summary: [{ type: "text", text: summary }], text: summary } : {}), ...attrs }, children: [A] },
      [A]: { id: A, type: "paragraph", version: 1, attrs: { text } },
    },
  })

  it("an unchanged details is the same; a summary edit changes it, with the summary's own word diff", () => {
    expect(diffBlockDocs(details("Who publishes"), details("Who publishes")).entries[0].status).toBe("same")
    const entry = diffBlockDocs(details("Who publishes"), details("Who can publish")).entries[0]
    expect(entry.status).toBe("changed")
    expect(entry.caption!.some((s) => s.op !== "same")).toBe(true)
    expect(entry.children!.map((c) => c.status)).toEqual(["same"])
  })

  it("shows Open by default as an attribute, and an edit inside on that block", () => {
    const entry = diffBlockDocs(details("Q"), details("Q", { open: true }, "answer!")).entries[0]
    expect(entry.attrs).toEqual([{ key: "open", label: "Open by default", version: "Off", working: "On" }])
    expect(entry.children![0].status).toBe("changed")
    // Shown with the block, unchanged.
    expect(entry.caption!.every((s) => s.op === "same")).toBe(true)
  })

  it("VersionDiff shows the summary's diff above the details' blocks", () => {
    const version = details("Who publishes")
    const working = details("Who can publish")
    const html = renderToStaticMarkup(<VersionDiff diff={diffBlockDocs(version, working)} version={version} working={working} />)
    expect(html).toContain('class="version-diff__summary"')
    expect(html).toMatch(/version-diff__container" data-type="details"><p class="version-diff__summary">/)
  })
})

describe("blockDiff with the layout blocks (#426)", () => {
  const COLS = "blk-columns-0001"
  const C1 = "blk-column-00001"
  const C2 = "blk-column-00002"
  const BTN = "blk-buttons-0001"
  const SPC = "blk-spacer-00001"
  const layout = (o: { layout?: string; align?: string; href?: string; label?: string; variant?: string; size?: string; buttonsAlign?: string; texts?: [string, string] } = {}): BlockDocV1 =>
    ({
      doc_version: 1,
      blocks_order: [COLS, BTN, SPC],
      blocks: {
        [COLS]: { id: COLS, type: "columns", version: 1, attrs: { ...(o.layout ? { layout: o.layout } : {}), ...(o.align ? { align: o.align } : {}) }, children: [C1, C2] },
        [C1]: { id: C1, type: "column", version: 1, attrs: {}, children: [A] },
        [C2]: { id: C2, type: "column", version: 1, attrs: {}, children: [B] },
        [A]: { id: A, type: "paragraph", version: 1, attrs: { text: o.texts?.[0] ?? "one" } },
        [B]: { id: B, type: "paragraph", version: 1, attrs: { text: o.texts?.[1] ?? "two" } },
        [BTN]: {
          id: BTN,
          type: "buttons",
          version: 1,
          attrs: {
            ...(o.buttonsAlign ? { align: o.buttonsAlign } : {}),
            text: o.label ?? "Read",
            pm: { type: "buttons", content: [{ type: "button", attrs: { href: o.href ?? "/a", ...(o.variant ? { variant: o.variant } : {}) }, content: [{ type: "text", text: o.label ?? "Read" }] }] },
          },
        },
        [SPC]: { id: SPC, type: "spacer", version: 1, attrs: { size: o.size ?? "7" } },
      },
    }) as unknown as BlockDocV1
  const entry = (diff: ReturnType<typeof diffBlockDocs>, id: string) => diff.entries.find((e) => e.id === id)!
  const attr = (e: { attrs: { key: string; version: string | null; working: string | null }[] }, key: string) => e.attrs.find((a) => a.key === key)

  it("identical docs are the same", () => {
    expect(diffBlockDocs(layout(), layout()).summary.changed).toBe(0)
  })

  it("a column's children are matched by id, and an edit shows on that block", () => {
    const columns = entry(diffBlockDocs(layout(), layout({ texts: ["one", "two!"] })), COLS)
    expect(columns.status).toBe("changed")
    expect(columns.children!.map((c) => c.id)).toEqual([C1, C2])
    expect(columns.children![1].children![0].status).toBe("changed")
  })

  it("names the layout and width as changes", () => {
    const columns = entry(diffBlockDocs(layout(), layout({ layout: "33-67", align: "wide" })), COLS)
    expect(attr(columns, "layout")).toMatchObject({ version: "Equal", working: "33 / 67" })
    expect(attr(columns, "align")).toMatchObject({ version: "Content", working: "Wide" })
  })

  it("a button's link and style are changes, its label a word diff", () => {
    const changed = entry(diffBlockDocs(layout(), layout({ href: "/b", variant: "secondary" })), BTN)
    expect(attr(changed, "buttons")).toMatchObject({ version: "Read → /a (primary)", working: "Read → /b (secondary)" })
    expect(entry(diffBlockDocs(layout(), layout({ buttonsAlign: "center" })), BTN).attrs[0]).toMatchObject({ key: "align", version: "Left", working: "Centre" })
    expect(entry(diffBlockDocs(layout(), layout({ label: "Read more" })), BTN).text!.length).toBeGreaterThan(0)
  })

  it("a spacer's height is in px", () => {
    expect(attr(entry(diffBlockDocs(layout(), layout({ size: "9" })), SPC), "size")).toMatchObject({ version: "48 px", working: "96 px" })
  })

  it("VersionDiff renders a changed columns block as a container", () => {
    const version = layout()
    const working = layout({ texts: ["one", "two!"] })
    const html = renderToStaticMarkup(<VersionDiff version={version} working={working} diff={diffBlockDocs(version, working)} />)
    expect(html).toContain('data-type="columns"')
  })
})
