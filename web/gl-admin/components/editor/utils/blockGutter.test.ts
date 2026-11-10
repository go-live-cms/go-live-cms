import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import { CORE_BLOCKS } from "../blocks/catalog"
import { refOf, topLevelBlockAt } from "./blockActions"
import { insertFromGutter } from "./blockGutter"
import { currentTableSizePicker } from "../ui/TableSizePicker"
import { currentColumnsPicker } from "../ui/ColumnsPicker"

// Inserting from the gutter's + (#415): every catalog block, below a block or into the
// empty line + is on, by the block's id.

stubJsdomRangeLayout()

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function makeEditor(content: string) {
  editor = new Editor({ element: document.createElement("div"), extensions: Object.values(schemaExtensions({ collaborating: false })), content })
  return editor
}

const PM_NODE: Record<string, string> = {
  paragraph: "paragraph",
  heading: "heading",
  bullet_list: "bulletList",
  ordered_list: "orderedList",
  blockquote: "blockquote",
  code_block: "codeBlock",
  image: "image",
  divider: "horizontalRule",
  group: "group",
  callout: "callout",
  pull_quote: "pullQuote",
  todo_list: "taskList",
  table: "tableBlock",
  details: "details",
  gallery: "gallery",
  video: "video",
  embed: "embed",
  html: "html",
  audio: "audio",
  file: "file",
  columns: "columns",
  buttons: "buttons",
  spacer: "spacer",
  cover: "cover",
  media_text: "mediaText",
}

// The table asks for its size first (#420): Create table with the defaults.
const createPickedTable = () => {
  currentTableSizePicker()?.submit()
  // The columns ask for a layout (#426).
  currentColumnsPicker()?.pick(0)
}

const types = (ed: Editor) => {
  const out: string[] = []
  ed.state.doc.forEach((node) => out.push(node.type.name))
  return out
}

describe("insertFromGutter", () => {
  it("refuses a block inside a gallery: only images go there, through Add images (#424)", () => {
    const ed = makeEditor('<div data-type="gallery"><figure data-align="inline"><img src="/a.jpg" data-block-id="image-aaaa-0000000000"></figure><div data-type="gallery-caption"></div></div><p>end</p>')
    expect(ed.state.doc.child(0).child(0).type.name).toBe("image")
    const before = ed.state.doc.toJSON()
    const entry = CORE_BLOCKS.find((e) => e.id === "image")!
    expect(insertFromGutter(ed, { id: ed.state.doc.child(0).child(0).attrs["data-block-id"], pos: 1 }, entry)).toBe(false)
    expect(ed.state.doc.toJSON()).toEqual(before)
  })

  it.each(CORE_BLOCKS.map((e) => [e.id, e] as const))("inserts %s on a new line below a block, which keeps its text", (_id, entry) => {
    const ed = makeEditor("<h2>Intro</h2><p>alpha</p><p>end</p>")
    const alpha = topLevelBlockAt(ed.state.doc, ed.state.doc.firstChild!.nodeSize)!
    expect(insertFromGutter(ed, refOf(alpha), entry)).toBe(true)
    createPickedTable()
    expect(types(ed)[2]).toBe(PM_NODE[entry.type])
    expect(ed.state.doc.child(1).textContent).toBe("alpha")
    expect(ed.state.doc.lastChild!.textContent).toBe("end")
    expect(ed.state.doc.textContent).toBe("Introalphaend")
  })

  it.each(CORE_BLOCKS.map((e) => [e.id, e] as const))("turns the empty line + is on into %s", (_id, entry) => {
    const ed = makeEditor("<p>alpha</p><p></p><p>end</p>")
    const empty = topLevelBlockAt(ed.state.doc, ed.state.doc.firstChild!.nodeSize)!
    expect(insertFromGutter(ed, refOf(empty), entry)).toBe(true)
    createPickedTable()
    expect(types(ed)[1]).toBe(PM_NODE[entry.type])
    expect(ed.state.doc.firstChild!.textContent).toBe("alpha")
  })

  it("finds the block by its id, and refuses one that's gone", () => {
    const ed = makeEditor('<p data-block-id="block-alpha-0001">alpha</p><p data-block-id="block-end-00001">end</p>')
    const ref = refOf(topLevelBlockAt(ed.state.doc, 0)!)
    expect(ref.id).toBe("block-alpha-0001")
    // A collaborator inserts a block above: the ref still finds "alpha".
    ed.commands.insertContentAt(0, "<h2>New</h2>")
    const heading = CORE_BLOCKS.find((e) => e.id === "heading-3")!
    expect(insertFromGutter(ed, ref, heading)).toBe(true)
    expect(types(ed)).toEqual(["heading", "paragraph", "heading", "paragraph"])
    expect(ed.state.doc.child(2).attrs.level).toBe(3)

    ed.commands.setContent('<p data-block-id="block-other-0001">other</p>')
    expect(insertFromGutter(ed, ref, heading)).toBe(false)
  })
})
