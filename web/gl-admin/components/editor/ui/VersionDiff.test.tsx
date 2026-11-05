import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { getInstalledCollabSchema } from "@gl-admin/lib/theme-blocks/collabSchema"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import type { PostSettings } from "@gl-admin/lib/api/blockAPI"
import { diffBlockDocs } from "@gl-admin/lib/history/blockDiff"
import VersionDiff, {
  diffSummaryText,
  MOVED_LABEL,
  SettingsDiff,
  TitleDiff,
  VERSION_ONLY_LABEL,
  WORKING_ONLY_LABEL,
} from "./VersionDiff"

// Rendering "Highlight changes" (#355): labels and icons for blocks on one side only (not
// colour alone), <ins>/<del> inside changed blocks, unchanged blocks marked for dimming,
// attribute notes, lists, theme blocks.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const schema = getInstalledCollabSchema()
type J = Record<string, unknown>
const text = (t: string) => ({ type: "text", text: t })
const p = (id: string, t: string) => ({ type: "paragraph", attrs: { "data-block-id": id }, content: [text(t)] })
const h = (id: string, level: number, t: string) => ({
  type: "heading",
  attrs: { "data-block-id": id, level },
  content: [text(t)],
})
const li = (id: string, t: string) => ({
  type: "listItem",
  attrs: { "data-block-id": id },
  content: [{ type: "paragraph", content: [text(t)] }],
})
const ul = (id: string, ...items: J[]) => ({ type: "bulletList", attrs: { "data-block-id": id }, content: items })
const img = (id: string, attrs: J = {}) => ({
  type: "image",
  attrs: { "data-block-id": id, src: "/uploads/cat.jpg", mediaId: 7, alt: "A cat", ...attrs },
})
const alert = (id: string, t: string, variant = "info") => ({
  type: "theme:example/alert",
  attrs: { "data-block-id": id, variant },
  content: [text(t)],
})
const doc = (...content: J[]): BlockDocV1 => pmToBlockDoc(schema.nodeFromJSON({ type: "doc", content }))

function render(version: BlockDocV1, working: BlockDocV1) {
  const diff = diffBlockDocs(version, working)
  act(() => root.render(<VersionDiff diff={diff} version={version} working={working} />))
  return diff
}
const block = (id: string) => container.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!

const A = "block-aaaa01"
const B = "block-bbbb02"
const C = "block-cccc03"
const D = "block-dddd04"

describe("VersionDiff", () => {
  it("labels blocks only in the version and only in the working copy, with an icon", () => {
    render(doc(p(A, "Kept"), p(B, "Only here")), doc(p(A, "Kept"), p(C, "Gone in the version")))
    const version = block(B)
    expect(version.className).toContain("version-diff__block--version")
    expect(version.textContent).toContain(VERSION_ONLY_LABEL)
    expect(version.querySelector(".version-diff__label svg")).not.toBeNull()
    expect(version.querySelector("ins.version-diff__whole p")?.textContent).toBe("Only here")

    const working = block(C)
    expect(working.className).toContain("version-diff__block--working")
    expect(working.textContent).toContain(WORKING_ONLY_LABEL)
    expect(working.querySelector(".version-diff__label svg")).not.toBeNull()
    expect(working.querySelector("del.version-diff__whole p")?.textContent).toBe("Gone in the version")
  })

  it("shows inline insertions and deletions inside a changed block", () => {
    render(doc(p(A, "GoLive syncs every keystroke, even across tabs.")), doc(p(A, "GoLive syncs each keystroke.")))
    const changed = block(A)
    expect(changed.className).toContain("version-diff__block--changed")
    const para = changed.querySelector("p")!
    expect(para.querySelector("ins")?.textContent).toBe("every")
    expect([...para.querySelectorAll("ins")].map((n) => n.textContent)).toEqual(["every", ", even across tabs"])
    expect([...para.querySelectorAll("del")].map((n) => n.textContent)).toEqual(["each"])
    expect(para.textContent).toBe("GoLive syncs everyeach keystroke, even across tabs.")
  })

  it("marks unchanged blocks for dimming, but not when nothing changed at all", () => {
    render(doc(p(A, "Same"), p(B, "new")), doc(p(A, "Same"), p(B, "old")))
    expect(block(A).className).toContain("version-diff__block--same")
    expect(container.querySelector(".version-diff--identical")).toBeNull()

    render(doc(p(A, "Same")), doc(p(A, "Same")))
    expect(container.querySelector(".version-diff--identical")).not.toBeNull()
  })

  it("labels a moved block", () => {
    render(doc(p(A, "a"), p(B, "b"), p(C, "c")), doc(p(B, "b"), p(C, "c"), p(A, "a")))
    expect(block(A).className).toContain("version-diff__block--moved")
    expect(block(A).textContent).toContain(MOVED_LABEL)
    expect(block(B).textContent).not.toContain(MOVED_LABEL)
  })

  it("notes attribute-only changes in words (heading level, image width)", () => {
    render(doc(h(A, 3, "Title"), img(B, { align: "wide" })), doc(h(A, 2, "Title"), img(B)))
    expect(block(A).querySelector("h3")?.textContent).toBe("Title")
    expect(block(A).querySelector(".version-diff__attrs")?.textContent).toBe(
      "Heading level: H3 in this version, H2 in working copy"
    )
    expect(block(B).querySelector("img")).not.toBeNull()
    expect(block(B).querySelector(".version-diff__attrs")?.textContent).toBe(
      "Width: Wide in this version, Inline in working copy"
    )
  })

  it("renders list items on one side with a marker and screen-reader text", () => {
    render(
      doc(ul(A, li("item-000001", "same"), li("item-000002", "added"))),
      doc(ul(A, li("item-000001", "same"), li("item-000003", "removed")))
    )
    const items = [...block(A).querySelectorAll("li")]
    expect(items.map((i) => i.className.match(/version-diff__item--(\w+)/)?.[1])).toEqual([
      "same",
      "version",
      "working",
    ])
    expect(items[1].querySelector("ins")?.textContent).toContain("added")
    expect(items[1].querySelector(".version-diff__sr")?.textContent).toBe(`${VERSION_ONLY_LABEL}: `)
    expect(items[2].querySelector("del")?.textContent).toContain("removed")
    expect(items[2].querySelector(".version-diff__item-mark svg")).not.toBeNull()
  })

  it("renders a changed theme block through its renderer, with its text and attribute changes", () => {
    render(doc(alert(A, "Heads up, friend", "warning")), doc(alert(A, "Heads up")))
    const changed = block(A)
    expect(changed.className).toContain("version-diff__block--changed")
    expect(changed.textContent).toContain("Heads up, friend") // the theme's render.tsx
    expect(changed.querySelector(".version-diff__text-changes ins")?.textContent).toBe(", friend")
    expect(changed.querySelector(".version-diff__attrs")?.textContent).toBe(
      "variant: warning in this version, info in working copy"
    )
  })

  it("says so for a block this build can't render, instead of showing nothing", () => {
    const version: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [D],
      blocks: { [D]: { id: D, type: "theme:gone/widget", version: 1, attrs: { text: "x" } } },
    }
    render(version, doc())
    expect(block(D).textContent).toContain("A Widget block this editor can't show.")
  })
})

describe("diffSummaryText", () => {
  it("counts each kind of change", () => {
    const diff = diffBlockDocs(
      doc(p(A, "a"), p(B, "new"), p(C, "c")),
      doc(p(C, "c"), p(A, "a"), p(B, "old"), p(D, "d"))
    )
    expect(diffSummaryText(diff)).toBe("1 block changed · 1 only in working copy · 1 moved")
    expect(diffSummaryText(diffBlockDocs(doc(p(A, "a")), doc(p(A, "a"))))).toBe("Same content as the working copy")
  })
})

describe("settings and title", () => {
  const base: PostSettings = {
    title: "Shipping real-time collaboration",
    description: "",
    featured_image: null,
    term_ids: [1, 2],
  }

  it("shows the version's title with the working copy's words struck", () => {
    act(() =>
      root.render(
        <TitleDiff version="Shipping real-time collaboration" working="Shipping real-time collaboration in GoLive" />
      )
    )
    const h1 = container.querySelector("h1")!
    expect(h1.querySelector("del")?.textContent).toBe(" in GoLive")
    expect(h1.querySelector("ins")).toBeNull()
  })

  it("lists only the settings that differ", () => {
    act(() =>
      root.render(
        <SettingsDiff
          version={{ ...base, seo_title: "Real-time collaboration, explained", noindex: true }}
          working={{ ...base, seo_title: "Real-time collaboration in GoLive: how it works", term_ids: [2, 1] }}
        />
      )
    )
    const terms = [...container.querySelectorAll("dt")].map((dt) => dt.textContent)
    expect(terms).toEqual(["SEO title", "Search engines"])
    expect(container.querySelector("dd ins")?.textContent).toBe(", explained")
    expect(container.querySelector("dd del")?.textContent).toBe(" in GoLive: how it works")
  })

  it("says the settings are the same when they are", () => {
    act(() => root.render(<SettingsDiff version={base} working={{ ...base }} />))
    expect(container.textContent).toContain("Same as the working copy")
  })
})
