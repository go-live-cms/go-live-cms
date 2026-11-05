import { describe, expect, it } from "vitest"
import { pmToBlockDoc } from "../collaboration/blockBridge"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import type { BlockDocV1 } from "../blocks-spec"
import { align, diffBlockDocs, isIdentical, longestIncreasing, type BlockDiffEntry, type ItemDiff } from "./blockDiff"
import type { Segment } from "./wordDiff"

// History's block diff (#355). Docs are built the way the collab server stores them: PM
// JSON through the real schema (core + installed theme blocks) and pmToBlockDoc.

const schema = getInstalledCollabSchema()

type J = Record<string, unknown>
const text = (t: string, marks?: J[]) => ({ type: "text", text: t, ...(marks ? { marks } : {}) })
const p = (id: string, t?: string, attrs: J = {}) => ({
  type: "paragraph",
  attrs: { "data-block-id": id, ...attrs },
  ...(t ? { content: [text(t)] } : {}),
})
const h = (id: string, level: number, t: string) => ({
  type: "heading",
  attrs: { "data-block-id": id, level },
  content: [text(t)],
})
const li = (id: string, t: string, ...nested: J[]) => ({
  type: "listItem",
  attrs: { "data-block-id": id },
  content: [{ type: "paragraph", content: [text(t)] }, ...nested],
})
const ul = (id: string | null, ...items: J[]) => ({
  type: "bulletList",
  attrs: id ? { "data-block-id": id } : {},
  content: items,
})
const ol = (id: string | null, ...items: J[]) => ({
  type: "orderedList",
  attrs: id ? { "data-block-id": id } : {},
  content: items,
})
const img = (id: string, attrs: J = {}, caption?: string) => ({
  type: "image",
  attrs: { "data-block-id": id, src: "/uploads/cat.jpg", mediaId: 7, alt: "A cat", ...attrs },
  ...(caption ? { content: [{ type: "imageCaption", content: [text(caption)] }] } : {}),
})
const quote = (id: string, t: string, cite?: string) => ({
  type: "blockquote",
  attrs: { "data-block-id": id, ...(cite ? { cite } : {}) },
  content: [{ type: "paragraph", content: [text(t)] }],
})
const alert = (id: string, t: string, variant = "info") => ({
  type: "theme:example/alert",
  attrs: { "data-block-id": id, variant },
  content: [text(t)],
})

const doc = (...content: J[]): BlockDocV1 => pmToBlockDoc(schema.nodeFromJSON({ type: "doc", content }))

const show = (segments: Segment[] | undefined) =>
  (segments ?? [])
    .map((s) => (s.kind ? "¶" : s.op === "same" ? s.text : s.op === "version" ? `[+${s.text}]` : `[-${s.text}]`))
    .join("")
const entry = (entries: BlockDiffEntry[], id: string) => entries.find((e) => e.id === id)!
const statuses = (entries: BlockDiffEntry[]) => entries.map((e) => `${e.id}:${e.status}${e.moved ? ":moved" : ""}`)

const A = "block-aaaa01"
const B = "block-bbbb02"
const C = "block-cccc03"
const D = "block-dddd04"
const E = "block-eeee05"

describe("diffBlockDocs", () => {
  it("finds nothing between identical docs", () => {
    const d = doc(h(A, 2, "Title"), p(B, "Body"), ul(C, li("item-000001", "one")), img(D))
    const diff = diffBlockDocs(d, structuredClone(d))
    expect(isIdentical(diff)).toBe(true)
    expect(diff.summary).toEqual({ changed: 0, versionOnly: 0, workingOnly: 0, moved: 0, same: 4 })
    expect(diff.entries.every((e) => e.status === "same" && !e.moved && e.attrs.length === 0)).toBe(true)
  })

  it("handles empty docs, {} and null on either side", () => {
    const empty = doc()
    expect(diffBlockDocs(empty, empty).entries).toEqual([])
    expect(diffBlockDocs(null, {} as BlockDocV1).entries).toEqual([])
    expect(statuses(diffBlockDocs(empty, doc(p(A, "x"))).entries)).toEqual([`${A}:working`])
    expect(statuses(diffBlockDocs(doc(p(A, "x")), {} as BlockDocV1).entries)).toEqual([`${A}:version`])
  })

  it("marks blocks only in the version, in the version's order", () => {
    const diff = diffBlockDocs(doc(p(A, "a"), p(B, "b"), p(C, "c")), doc(p(A, "a"), p(C, "c")))
    expect(statuses(diff.entries)).toEqual([`${A}:same`, `${B}:version`, `${C}:same`])
    expect(diff.summary.versionOnly).toBe(1)
  })

  it("puts blocks only in the working copy after the block they follow there", () => {
    const diff = diffBlockDocs(
      doc(p(A, "a"), p(C, "c")),
      doc(p(D, "first"), p(A, "a"), p(B, "b"), p(E, "e"), p(C, "c"))
    )
    expect(statuses(diff.entries)).toEqual([`${D}:working`, `${A}:same`, `${B}:working`, `${E}:working`, `${C}:same`])
    expect(diff.summary.workingOnly).toBe(3)
  })

  it("diffs an edited block word by word", () => {
    const diff = diffBlockDocs(
      doc(p(A, "GoLive syncs every keystroke, even across tabs.")),
      doc(p(A, "GoLive syncs every keystroke."))
    )
    const e = entry(diff.entries, A)
    expect(e.status).toBe("changed")
    expect(show(e.text)).toBe("GoLive syncs every keystroke[+, even across tabs].")
  })

  it("keeps marks on the diff and counts a mark-only change", () => {
    const version = doc({
      type: "paragraph",
      attrs: { "data-block-id": A },
      content: [text("make it "), text("bold", [{ type: "bold" }])],
    })
    const diff = diffBlockDocs(version, doc(p(A, "make it bold")))
    const e = entry(diff.entries, A)
    expect(e.status).toBe("changed")
    expect(e.text).toContainEqual({ op: "version", text: "bold", marks: [{ type: "bold" }] })
  })

  it("marks only the moved block, not every block it jumped over", () => {
    const diff = diffBlockDocs(
      doc(p(A, "a"), p(B, "b"), p(C, "c"), p(D, "d")),
      doc(p(A, "a"), p(C, "c"), p(D, "d"), p(B, "b"))
    )
    expect(statuses(diff.entries)).toEqual([`${A}:same`, `${B}:same:moved`, `${C}:same`, `${D}:same`])
    expect(diff.summary).toMatchObject({ moved: 1, same: 3, changed: 0 })
    expect(isIdentical(diff)).toBe(false)
  })

  it("reports a moved block that was also edited as both", () => {
    const diff = diffBlockDocs(doc(p(A, "a"), p(B, "bee")), doc(p(B, "b"), p(A, "a")))
    const moved = diff.entries.filter((e) => e.moved)
    expect(moved).toHaveLength(1)
    const b = entry(diff.entries, B)
    expect(b.status).toBe("changed")
    expect(show(b.text)).toBe("[+bee][-b]")
  })

  it("leaves out blank paragraphs at the end (the editor's trailing node) and repeated ids", () => {
    const version = doc(p(A, "a"), p("blank-000001"))
    const working = doc(p(A, "a"), p("blank-000002"))
    expect(isIdentical(diffBlockDocs(version, working))).toBe(true)
    const repeated = { ...version, blocks_order: [A, A] }
    expect(diffBlockDocs(repeated, working).entries).toHaveLength(1)
  })

  describe("attribute-only changes", () => {
    it("heading level", () => {
      const e = entry(diffBlockDocs(doc(h(A, 3, "Title")), doc(h(A, 2, "Title"))).entries, A)
      expect(e.status).toBe("changed")
      expect(e.attrs).toEqual([{ key: "level", label: "Heading level", version: "H3", working: "H2" }])
      expect(show(e.text)).toBe("Title")
    })

    it("paragraph alignment", () => {
      const e = entry(diffBlockDocs(doc(p(A, "x", { textAlign: "center" })), doc(p(A, "x"))).entries, A)
      expect(e.attrs).toEqual([{ key: "textAlign", label: "Alignment", version: "Center", working: "Left" }])
    })

    it("image width (#346)", () => {
      const e = entry(diffBlockDocs(doc(img(A, { align: "wide" })), doc(img(A))).entries, A)
      expect(e.status).toBe("changed")
      expect(e.attrs).toEqual([{ key: "align", label: "Width", version: "Wide", working: "Inline" }])
    })

    it("image caption (#346), as a word diff", () => {
      const e = entry(diffBlockDocs(doc(img(A, {}, "A sleepy cat")), doc(img(A, {}, "A cat"))).entries, A)
      expect(e.status).toBe("changed")
      expect(e.attrs).toEqual([])
      expect(show(e.caption)).toBe("A [+sleepy ]cat")
    })

    it("image file and alt text", () => {
      const e = entry(
        diffBlockDocs(doc(img(A, { src: "/uploads/dog.jpg", mediaId: 8, alt: "A dog" })), doc(img(A))).entries,
        A
      )
      expect(e.attrs.map((a) => [a.key, a.version, a.working])).toEqual([
        ["file", "dog.jpg (#8)", "cat.jpg (#7)"],
        ["alt", "A dog", "A cat"],
      ])
    })

    it("quote citation (#346)", () => {
      const e = entry(diffBlockDocs(doc(quote(A, "Words.", "Ana")), doc(quote(A, "Words."))).entries, A)
      expect(e.attrs).toEqual([{ key: "cite", label: "Citation", version: "Ana", working: null }])
    })

    it("list type", () => {
      const e = entry(
        diffBlockDocs(doc(ol(A, li("item-000001", "one"))), doc(ul(A, li("item-000001", "one")))).entries,
        A
      )
      expect(e.status).toBe("changed")
      expect(e.attrs).toEqual([{ key: "listType", label: "List type", version: "Numbered", working: "Bulleted" }])
    })
  })

  it("reports a block turned into another type, with its text diff", () => {
    const e = entry(diffBlockDocs(doc(h(A, 2, "Why it matters")), doc(p(A, "Why this matters"))).entries, A)
    expect(e.status).toBe("changed")
    expect(e.attrs).toEqual([{ key: "type", label: "Block type", version: "Heading", working: "Paragraph" }])
    expect(show(e.text)).toBe("Why [+it][-this] matters")
  })

  describe("lists", () => {
    const I1 = "item-000001"
    const I2 = "item-000002"
    const I3 = "item-000003"
    const N1 = "item-nested1"
    const N2 = "item-nested2"
    const itemShow = (items: ItemDiff[]): string[] =>
      items.flatMap((i) => [
        `${i.id}:${i.status}${i.moved ? ":moved" : ""}:${show(i.text)}`,
        ...i.lists.flatMap((l) => itemShow(l.items).map((s) => `  ${s}`)),
      ])

    it("matches items by id: added, removed, edited", () => {
      const version = doc(ul(A, li(I1, "See who is here"), li(I2, "Comments stay attached")))
      const working = doc(ul(A, li(I1, "See who is in the post"), li(I3, "Contributors keep view-only access")))
      const e = entry(diffBlockDocs(version, working).entries, A)
      expect(e.status).toBe("changed")
      expect(itemShow(e.list!.items)).toEqual([
        `${I1}:changed:See who is [+here][-in the post]`,
        `${I2}:version:[+Comments stay attached]`,
        `${I3}:working:[-Contributors keep view-only access]`,
      ])
    })

    it("diffs nested lists by their items' ids", () => {
      const version = doc(ul(A, li(I1, "Parent", ul(null, li(N1, "child one edited"), li(N2, "child two")))))
      const working = doc(ul(A, li(I1, "Parent", ul(null, li(N1, "child one")))))
      const e = entry(diffBlockDocs(version, working).entries, A)
      expect(itemShow(e.list!.items)).toEqual([
        `${I1}:changed:Parent`,
        `  ${N1}:changed:child one[+ edited]`,
        `  ${N2}:version:[+child two]`,
      ])
    })

    it("reports a nested list only on one side", () => {
      const version = doc(ul(A, li(I1, "Parent")))
      const working = doc(ul(A, li(I1, "Parent", ol(null, li(N1, "new child")))))
      const e = entry(diffBlockDocs(version, working).entries, A)
      expect(e.list!.items[0].lists).toHaveLength(1)
      expect(e.list!.items[0].lists[0]).toMatchObject({ ordered: true, status: "working" })
      expect(itemShow(e.list!.items)).toEqual([`${I1}:changed:Parent`, `  ${N1}:working:[-new child]`])
    })

    it("marks a moved list item", () => {
      const version = doc(ul(A, li(I1, "one"), li(I2, "two"), li(I3, "three")))
      const working = doc(ul(A, li(I2, "two"), li(I3, "three"), li(I1, "one")))
      const e = entry(diffBlockDocs(version, working).entries, A)
      expect(e.status).toBe("changed")
      expect(itemShow(e.list!.items)).toEqual([`${I1}:same:moved:one`, `${I2}:same:two`, `${I3}:same:three`])
    })

    it("finds nothing in an unchanged nested list", () => {
      const d = doc(ul(A, li(I1, "Parent", ul(null, li(N1, "child")))))
      expect(isIdentical(diffBlockDocs(d, doc(ul(A, li(I1, "Parent", ul(null, li(N1, "child")))))))).toBe(true)
    })
  })

  describe("theme blocks (#376)", () => {
    it("compares declared attrs and text", () => {
      const e = entry(diffBlockDocs(doc(alert(A, "Heads up, friend", "warning")), doc(alert(A, "Heads up"))).entries, A)
      expect(e.status).toBe("changed")
      expect(e.attrs).toEqual([{ key: "variant", label: "variant", version: "warning", working: "info" }])
      expect(show(e.text)).toBe("Heads up[+, friend]")
    })

    it("finds an unchanged theme block unchanged, and one only on one side", () => {
      const d = doc(alert(A, "Same"), alert(B, "Only here"))
      const diff = diffBlockDocs(d, doc(alert(A, "Same")))
      expect(statuses(diff.entries)).toEqual([`${A}:same`, `${B}:version`])
    })
  })

  it("doesn't fail on an image src with a stray %", () => {
    const e = entry(diffBlockDocs(doc(img(A, { src: "/uploads/100%-done.jpg" })), doc(img(A))).entries, A)
    expect(e.attrs[0]).toMatchObject({ key: "file", version: "100%-done.jpg (#7)" })
  })

  it("counts a change to an inline node that isn't text", () => {
    const raw = (attrs: J): BlockDocV1 => ({
      doc_version: 1,
      blocks_order: [A],
      blocks: {
        [A]: {
          id: A,
          type: "theme:x/card",
          version: 1,
          attrs: { pm: { type: "theme:x/card", content: [text("Hi "), { type: "mention", attrs }] } },
        },
      },
    })
    const e = entry(diffBlockDocs(raw({ id: 1 }), raw({ id: 2 })).entries, A)
    expect(e.status).toBe("changed")
    expect(e.text).toContainEqual({ op: "version", text: "mention", kind: "node" })
  })

  it("reads a paragraph list child without pm from its plain text", () => {
    const list = (t: string): BlockDocV1 => ({
      doc_version: 1,
      blocks_order: [A],
      blocks: {
        [A]: { id: A, type: "bullet_list", version: 1, attrs: {}, children: [B] },
        [B]: { id: B, type: "paragraph", version: 1, attrs: { text: t } },
      },
    })
    const e = entry(diffBlockDocs(list("old words"), list("new words")).entries, A)
    // The version (first) has "old words", the working copy "new words".
    expect(show(e.list!.items[0].text)).toBe("[+old][-new] words")
  })

  it("compares code by word, keeping its whitespace", () => {
    const code = (id: string, src: string) => ({
      type: "codeBlock",
      attrs: { "data-block-id": id, language: "js" },
      content: [text(src)],
    })
    const e = entry(diffBlockDocs(doc(code(A, "const a = 1\nconst b = 2")), doc(code(A, "const a = 1"))).entries, A)
    expect(show(e.text)).toBe("const a = 1[+\nconst b = 2]")
  })
})

describe("align / longestIncreasing", () => {
  it("finds a longest increasing subsequence", () => {
    const seq = [0, 3, 1, 2, 5, 4]
    const lis = longestIncreasing(seq).map((i) => seq[i])
    expect(lis).toHaveLength(4)
    expect([...lis].sort((a, b) => a - b)).toEqual(lis)
    expect(longestIncreasing([])).toEqual([])
  })

  it("aligns by key with working-only items after their anchor", () => {
    const out = align(["a", "b", "c"], ["x", "c", "a", "y"], (s) => s)
    // a and c swapped: one of them moved (the LIS keeps the later one). y follows a in the
    // working copy: after a, behind the version's own b, before the next shared item.
    expect(out.map((o) => `${o.key}${o.version ? "v" : ""}${o.working ? "w" : ""}${o.moved ? "m" : ""}`)).toEqual([
      "xw",
      "avwm",
      "bv",
      "yw",
      "cvw",
    ])
  })
})
