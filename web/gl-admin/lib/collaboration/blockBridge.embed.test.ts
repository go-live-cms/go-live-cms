import { describe, it, expect } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import * as Y from "yjs"
import { EMBED_TITLE_MAX_LENGTH, validateBlockDoc, type BlockDocV1 } from "../blocks-spec"
import { blockDocToPMWithReport, pmToBlockDoc } from "./blockBridge"
import { fragmentToBlockDoc, seedFragment } from "./fragmentBridge"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import BlockRenderer from "@/components/BlockRenderer"

// The embed block (#425) through the chain the editor and the collab server use: Block Spec
// → ProseMirror → Block Spec, and through the Yjs fragment (seed, store), to the public
// page. It stores a provider, a ref valid for it, a plain-text title and a caption, and
// nothing else: nothing a client puts in the doc becomes HTML or an address.

const schema = getInstalledCollabSchema()

const YT = "blk-0425-youtube-0001"
const VIMEO = "blk-0425-vimeo-000001"
const EMPTY = "blk-0425-empty-000001"
const LINK = "blk-0425-link-0000001"
const GROUP = "blk-0425-group-000001"
const INNER = "blk-0425-inner-000001"

const t = (text: string, ...marks: string[]) => ({ type: "text", text, ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {}) })

function embedDoc(): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [YT, VIMEO, EMPTY, LINK, GROUP],
    blocks: {
      [YT]: { id: YT, type: "embed", version: 1, attrs: { provider: "youtube", ref: "dQw4w9WgXcQ", title: "Two editors, one draft", caption: [t("A two-minute "), t("demo", "italic")] } },
      [VIMEO]: { id: VIMEO, type: "embed", version: 1, attrs: { provider: "vimeo", ref: "76979871/8272103f6e" } },
      [EMPTY]: { id: EMPTY, type: "embed", version: 1, attrs: { provider: "x" } },
      [LINK]: { id: LINK, type: "embed", version: 1, attrs: {} },
      [GROUP]: { id: GROUP, type: "group", version: 1, attrs: {}, children: [INNER] },
      [INNER]: { id: INNER, type: "embed", version: 1, attrs: { provider: "spotify", ref: "track/4cOdK2wGLETKBW3PvgPWqT" } },
    },
  }
}

const stored = (doc: BlockDocV1) => pmToBlockDoc(blockDocToPMWithReport(doc, schema).node)

function seed(doc: BlockDocV1) {
  const ydoc = new Y.Doc()
  const fragment = ydoc.getXmlFragment("default")
  const dropped = seedFragment(doc, fragment, schema)
  return { ydoc, fragment, dropped }
}

/** One embed block with `attrs`, through the bridge and back. */
function through(attrs: Record<string, unknown>) {
  const doc: BlockDocV1 = { doc_version: 1, blocks_order: [YT], blocks: { [YT]: { id: YT, type: "embed", version: 1, attrs } as any } }
  return stored(doc).blocks[YT].attrs as Record<string, unknown>
}

describe("the embed block in the bridge (#425)", () => {
  it("round-trips unchanged: filled, empty, with a caption, and in a group", () => {
    const doc = embedDoc()
    expect(stored(doc)).toEqual(doc)
    expect(() => validateBlockDoc(stored(doc))).not.toThrow()
  })

  it("is a flow block with a caption child, not in the `block` group", () => {
    expect(schema.nodes.embed.spec.group).toBeUndefined()
    const { node } = blockDocToPMWithReport(embedDoc(), schema)
    expect(node.child(0).type.name).toBe("embed")
    expect(node.child(0).child(0).type.name).toBe("imageCaption")
    expect(node.child(1).childCount).toBe(0)
    expect(() => node.check()).not.toThrow()
  })

  it("drops a ref that isn't valid for its provider", () => {
    expect(through({ provider: "youtube", ref: "../../evil" })).toEqual({ provider: "youtube" })
    expect(through({ provider: "vimeo", ref: "dQw4w9WgXcQ" })).toEqual({ provider: "vimeo" })
  })

  it("drops an unknown provider and anything it isn't", () => {
    expect(through({ provider: "tiktok", ref: "dQw4w9WgXcQ" })).toEqual({})
    expect(through({ provider: "youtube", ref: "dQw4w9WgXcQ", src: "https://evil.example", html: "<iframe>" })).toEqual({ provider: "youtube", ref: "dQw4w9WgXcQ" })
  })

  it("keeps the title plain text and capped", () => {
    expect(through({ provider: "x", title: "  Post\tby jack " })).toEqual({ provider: "x", title: "Post by jack" })
    expect(through({ provider: "x", title: "<img src=x onerror=alert(1)>" })).toEqual({ provider: "x" })
    expect([...(through({ provider: "x", title: "é".repeat(EMBED_TITLE_MAX_LENGTH + 9) }).title as string)]).toHaveLength(EMBED_TITLE_MAX_LENGTH)
  })

  it("reduces a caption to its runs and marks", () => {
    const caption = [t("Plain "), { type: "text", text: "bad", marks: [{ type: "highlight" }] }, { type: "image" }]
    expect(through({ provider: "x", caption })).toEqual({ provider: "x", caption: [t("Plain "), t("bad")] })
  })

  it("goes through the fragment: a seed stores the same doc, with nothing dropped", () => {
    const doc = embedDoc()
    const { fragment, dropped } = seed(doc)
    expect(dropped.entries).toEqual([])
    const out = fragmentToBlockDoc(fragment, schema)
    expect(out).toEqual(doc)
    expect(() => validateBlockDoc(out)).not.toThrow()
  })

  it("ends at the public page as a placeholder that loads nothing", () => {
    const { fragment } = seed(embedDoc())
    const html = renderToStaticMarkup(React.createElement(BlockRenderer, { doc: fragmentToBlockDoc(fragment, schema) }))
    expect(html).toContain("Two editors, one draft")
    expect(html.match(/embed-frame/g)).toHaveLength(3)
    expect(html).not.toMatch(/<iframe|<img|https?:/)
    expect(html).toContain('data-embed-provider="spotify"')
  })
})
