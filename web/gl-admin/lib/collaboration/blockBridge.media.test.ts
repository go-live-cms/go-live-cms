import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import { FILE_LABEL_MAX_LENGTH, validateBlockDoc, type BlockDocV1 } from "../blocks-spec"
import { blockDocToPMWithReport, pmToBlockDoc } from "./blockBridge"
import { fragmentToBlockDoc, seedFragment } from "./fragmentBridge"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"

// The video, audio and file blocks (#423) through the chain the editor and the collab
// server use: Block Spec → ProseMirror → Block Spec, and through the Yjs fragment (seed,
// store). A block stores its media id and its caption (video, audio) or label (file), and
// nothing else: no src, no file name, no size (those are the media library's).

const schema = getInstalledCollabSchema()

const VIDEO = "blk-0423-video-000001"
const AUDIO = "blk-0423-audio-000001"
const FILE = "blk-0423-file-0000001"
const EMPTY = "blk-0423-empty-000001"
const GROUP = "blk-0423-group-000001"
const INNER = "blk-0423-inner-000001"

const t = (text: string, ...marks: string[]) => ({ type: "text", text, ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {}) })

function mediaDoc(): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [VIDEO, AUDIO, FILE, EMPTY, GROUP],
    blocks: {
      [VIDEO]: { id: VIDEO, type: "video", version: 1, attrs: { mediaId: 12, caption: [t("The launch "), t("walkthrough", "italic")] } },
      [AUDIO]: { id: AUDIO, type: "audio", version: 1, attrs: { mediaId: 13 } },
      [FILE]: { id: FILE, type: "file", version: 1, attrs: { mediaId: 14, label: "GoLive import checklist" } },
      [EMPTY]: { id: EMPTY, type: "video", version: 1, attrs: {} },
      [GROUP]: { id: GROUP, type: "group", version: 1, attrs: {}, children: [INNER] },
      [INNER]: { id: INNER, type: "file", version: 1, attrs: { mediaId: 15 } },
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

describe("video, audio and file in the bridge (#423)", () => {
  it("round-trip unchanged, an empty block and one in a group included", () => {
    const doc = mediaDoc()
    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(dropped).toEqual([])
    node.check()
    expect(stored(doc)).toEqual(doc)
    expect(() => validateBlockDoc(stored(doc))).not.toThrow()
  })

  it("build the editor's nodes: a caption child for video and audio, the label as the file's attr", () => {
    const { node } = blockDocToPMWithReport(mediaDoc(), schema)
    const video = node.child(0)
    expect(video.type.name).toBe("video")
    expect(video.attrs).toMatchObject({ mediaId: 12, "data-block-id": VIDEO })
    expect(video.firstChild?.type.name).toBe("imageCaption")
    expect(video.textContent).toBe("The launch walkthrough")
    expect(node.child(1).childCount).toBe(0)
    expect(node.child(2).attrs).toMatchObject({ mediaId: 14, label: "GoLive import checklist" })
    expect(node.child(2).isAtom).toBe(true)
  })

  it("survive the Yjs fragment: seed, then store", () => {
    const doc = mediaDoc()
    const { fragment, dropped } = seed(doc)
    expect(dropped.entries).toEqual([])
    expect(fragmentToBlockDoc(fragment, schema)).toEqual(doc)
  })

  it("keep only a positive integer media id and a valid label; leave defaults out", () => {
    const doc = mediaDoc()
    doc.blocks[VIDEO].attrs = { mediaId: "12", src: "javascript:alert(1)", caption: [] } as any
    doc.blocks[AUDIO].attrs = { mediaId: -3 } as any
    doc.blocks[FILE].attrs = { mediaId: 1.5, label: "  Checklist\u0007 for May  " } as any
    const out = stored(doc)
    // A numeric string is read as the number (older docs, HTML), the rest is dropped.
    expect(out.blocks[VIDEO].attrs).toEqual({ mediaId: 12 })
    expect(out.blocks[AUDIO].attrs).toEqual({})
    expect(out.blocks[FILE].attrs).toEqual({ label: "Checklist  for May" })
    expect(() => validateBlockDoc(out)).not.toThrow()
  })

  it("cap a file's label at FILE_LABEL_MAX_LENGTH code points", () => {
    const doc = mediaDoc()
    ;(doc.blocks[FILE].attrs as any).label = "🎉".repeat(FILE_LABEL_MAX_LENGTH + 5)
    const label = (stored(doc).blocks[FILE].attrs as any).label as string
    expect([...label]).toHaveLength(FILE_LABEL_MAX_LENGTH)
  })

  it("can't be a quote's or a list item's content: they're blocks of the doc or a group only", () => {
    expect(schema.nodes.blockquote.contentMatch.matchType(schema.nodes.video)).toBeNull()
    expect(schema.nodes.listItem.contentMatch.matchType(schema.nodes.file)).toBeNull()
    expect(schema.nodes.group.contentMatch.matchType(schema.nodes.audio)).not.toBeNull()
    expect(schema.topNodeType.contentMatch.matchType(schema.nodes.video)).not.toBeNull()
  })
})

describe("Block Spec's validators (#423)", () => {
  it.each([
    ["a media id that isn't an integer", (d: BlockDocV1) => ((d.blocks[VIDEO].attrs as any).mediaId = 1.5)],
    ["a media id that isn't positive", (d: BlockDocV1) => ((d.blocks[AUDIO].attrs as any).mediaId = 0)],
    ["a media id as a string", (d: BlockDocV1) => ((d.blocks[FILE].attrs as any).mediaId = "14")],
    ["a caption run without text", (d: BlockDocV1) => ((d.blocks[VIDEO].attrs as any).caption = [{ type: "text", text: "" }])],
    ["an empty label", (d: BlockDocV1) => ((d.blocks[FILE].attrs as any).label = "")],
    ["a label over the cap", (d: BlockDocV1) => ((d.blocks[FILE].attrs as any).label = "x".repeat(FILE_LABEL_MAX_LENGTH + 1))],
    ["children on a video", (d: BlockDocV1) => ((d.blocks[VIDEO] as any).children = [])],
  ])("refuse %s", (_name, change) => {
    const doc = mediaDoc()
    change(doc)
    expect(() => validateBlockDoc(doc)).toThrow()
  })

  it("take the bridge's output", () => {
    expect(() => validateBlockDoc(stored(mediaDoc()))).not.toThrow()
  })
})