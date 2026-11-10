import { afterEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { DOMSerializer, Slice, Fragment } from "@tiptap/pm/model"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { pmToBlockDoc, setEditorBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { FootnoteEditing, footnoteNumbers, keepKnownFootnoteRefs } from "./FootnoteEditing"
import { PasteSanitizer, sanitizePastedHTML } from "./PasteSanitizer"
import { findFootnotesList, footnoteUses } from "./FootnotesBlock"
import { CORE_BLOCKS, findEntry, slotAcceptsAt } from "../blocks/catalog"
import { duplicateBlock, refOf, topLevelBlockAt } from "../utils/blockActions"
import { deleteBlockTr, editorBlockAtSelection, isEditorBlock } from "../utils/blockTree"
import { insertFromGutter } from "../utils/blockGutter"

const editors: Editor[] = []

function makeEditor(content: BlockDocV1 | string = "<p>one</p><p>two</p>"): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [...Object.values(schemaExtensions({ collaborating: false })), FootnoteEditing, PasteSanitizer],
    ...(typeof content === "string" ? { content } : {}),
  })
  if (typeof content !== "string") setEditorBlockDoc(editor, content)
  editors.push(editor)
  return editor
}

afterEach(() => {
  while (editors.length) {
    const editor = editors.pop()!
    const element = editor.options.element as HTMLElement
    editor.destroy()
    element.remove()
  }
  vi.restoreAllMocks()
})

const endOf = (ed: Editor, index: number) => {
  let pos = 0
  for (let i = 0; i <= index; i++) pos += ed.state.doc.child(i).nodeSize
  return pos - 1
}
const blockTypes = (ed: Editor) => {
  const types: string[] = []
  ed.state.doc.forEach((node) => types.push(node.type.name))
  return types
}
const insertAt = (ed: Editor, pos: number) => {
  ed.commands.setTextSelection(pos)
  expect(ed.commands.insertFootnote()).toBe(true)
}
const refs = (ed: Editor) => Array.from(ed.view.dom.querySelectorAll<HTMLElement>('[data-type="footnote-ref"]'))
const notes = (ed: Editor) => Array.from(ed.view.dom.querySelectorAll<HTMLElement>('[data-type="footnote"]'))
const listNode = (ed: Editor) => findFootnotesList(ed.state.doc)!.node
const noteIds = (ed: Editor) => {
  const ids: string[] = []
  listNode(ed).forEach((note) => ids.push(note.attrs["data-block-id"]))
  return ids
}
const typeInNote = (ed: Editor, text: string) => ed.commands.insertContent(text)
const press = (ed: Editor, key: string) => ed.view.someProp("handleKeyDown", (handler) => handler(ed.view, new KeyboardEvent("keydown", { key })))

describe("insert (#422)", () => {
  it("adds the reference and its note, creating the list, in one transaction", () => {
    const ed = makeEditor()
    const dispatched: boolean[] = []
    ed.commands.setTextSelection(endOf(ed, 0))
    ed.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) dispatched.push(true)
    })
    ed.commands.insertFootnote()
    expect(dispatched).toHaveLength(1)
    expect(blockTypes(ed)).toEqual(["paragraph", "paragraph", "footnotes"])
    const [id] = noteIds(ed)
    expect(id).toMatch(/.{10,}/)
    expect(footnoteUses(ed.state.doc).get(id)).toHaveLength(1)
    // The caret is in the new note.
    expect(ed.state.selection.$from.parent.type.name).toBe("footnote")
    ed.state.doc.check()
  })

  it("puts the reference after a selection, leaving it", () => {
    const ed = makeEditor()
    ed.commands.setTextSelection({ from: 1, to: 4 })
    ed.commands.insertFootnote()
    const first = ed.state.doc.child(0)
    expect(first.textContent).toBe("one")
    expect(first.child(1).type.name).toBe("footnoteRef")
  })

  it("uses the post's one list for every later note", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    insertAt(ed, endOf(ed, 1))
    expect(blockTypes(ed)).toEqual(["paragraph", "paragraph", "footnotes"])
    expect(listNode(ed).childCount).toBe(2)
  })

  it("places a new note in reference order", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 1))
    const later = noteIds(ed)[0]
    insertAt(ed, endOf(ed, 0))
    const ids = noteIds(ed)
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(later)
  })

  it("from the slash menu, replaces the typed query", () => {
    const ed = makeEditor("<p>first</p><p>/foot</p>")
    const from = ed.state.doc.child(0).nodeSize + 1
    findEntry("footnote")!.insert(ed, { from, to: from + 5 })
    expect(ed.state.doc.child(1).textContent).toBe("")
    expect(ed.state.doc.child(1).child(0).type.name).toBe("footnoteRef")
  })

  it("isn't offered where text can't hold one: code, captions, a note", () => {
    const ed = makeEditor("<pre><code>x</code></pre><p>y</p>")
    ed.commands.setTextSelection(1)
    expect(ed.can().insertFootnote()).toBe(false)
    expect(slotAcceptsAt(ed)(findEntry("footnote")!)).toBe(false)
    ed.commands.setTextSelection(endOf(ed, 1))
    expect(ed.can().insertFootnote()).toBe(true)
    ed.commands.insertFootnote()
    // The caret is in the note now.
    expect(ed.can().insertFootnote()).toBe(false)
    const content = ed.state.doc.lastChild!.child(0).content.size
    expect(content).toBe(0)
  })

  it("a slash range isn't deleted when the reference can't go there", () => {
    const ed = makeEditor("<pre><code>/foot</code></pre><p>y</p>")
    expect(ed.commands.insertFootnote({ from: 1, to: 6 })).toBe(false)
    expect(ed.state.doc.child(0).textContent).toBe("/foot")
  })

  it("from the gutter's +, goes on a new line below the block", () => {
    const ed = makeEditor()
    const block = topLevelBlockAt(ed.state.doc, 0)!
    expect(insertFromGutter(ed, refOf(block), findEntry("footnote")!)).toBe(true)
    expect(blockTypes(ed)).toEqual(["paragraph", "paragraph", "paragraph", "footnotes"])
    expect(ed.state.doc.child(1).child(0).type.name).toBe("footnoteRef")
    expect(ed.state.doc.child(0).textContent).toBe("one")
  })

  it("is in the catalog, and only the text group", () => {
    const entry = CORE_BLOCKS.find((e) => e.id === "footnote")!
    expect(entry.group).toBe("text")
    expect(entry.inline).toBe(true)
  })
})

describe("no appendTransaction (rule 7)", () => {
  it("adds none: nothing reacts to a change by writing footnotes", () => {
    const ed = makeEditor()
    const ours = ed.state.plugins.filter((plugin) => (plugin as any).key.startsWith("footnoteEditing"))
    expect(ours).toHaveLength(1)
    expect((ours[0] as any).spec.appendTransaction).toBeUndefined()
    expect((ours[0] as any).spec.filterTransaction).toBeUndefined()
  })
})

describe("numbers are derived, never stored", () => {
  it("follows the references and stores none", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 1))
    expect(refs(ed).map((el) => el.dataset.footnoteNumber)).toEqual(["1"])
    insertAt(ed, endOf(ed, 0))
    expect(refs(ed).map((el) => el.dataset.footnoteNumber)).toEqual(["1", "2"])
    expect(refs(ed)[0].getAttribute("aria-label")).toBe("Footnote 1")
    expect(JSON.stringify(ed.state.doc.toJSON())).not.toMatch(/number/i)
  })

  it("a deleted reference renumbers the rest", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    insertAt(ed, endOf(ed, 1))
    const first = ed.state.doc.child(0).content.size
    ed.commands.deleteRange({ from: first, to: first + 1 })
    expect(refs(ed).map((el) => el.dataset.footnoteNumber)).toEqual(["1"])
  })

  it("shows notes in number order, whatever the list's order", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    insertAt(ed, endOf(ed, 1))
    const [firstId, secondId] = noteIds(ed)
    expect(footnoteNumbers(ed.state.doc).get(firstId)).toBe(1)
    // Swap the paragraphs (a move nobody re-sorts the list for).
    const { doc } = ed.state
    const one = doc.child(0)
    const two = doc.child(1)
    ed.view.dispatch(ed.state.tr.replaceWith(0, one.nodeSize + two.nodeSize, [two, one]))
    expect(footnoteNumbers(ed.state.doc).get(secondId)).toBe(1)
    const rows = notes(ed)
    expect(rows.map((row) => row.style.order)).toEqual(["2", "1"])
    expect(rows[0].querySelector(".editor-footnote__number")!.textContent).toBe("2.")
  })
})

describe("a reference deleted while its note remains", () => {
  it("keeps the note, flagged, with Remove; the text is never deleted silently", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    typeInNote(ed, "keep me")
    const end = ed.state.doc.child(0).content.size
    ed.commands.deleteRange({ from: end, to: end + 1 })
    expect(listNode(ed).textContent).toBe("keep me")
    const [row] = notes(ed)
    expect(row.classList.contains("is-unreferenced")).toBe(true)
    expect((row.querySelector(".editor-footnote__remove") as HTMLButtonElement).hidden).toBe(false)
    expect((row.querySelector(".editor-footnote__back") as HTMLButtonElement).hidden).toBe(true)
    expect(row.querySelector(".editor-footnote__unreferenced")!.textContent).toBe("Not referenced")
  })

  it("Remove takes the note, and the list with the last one", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    insertAt(ed, endOf(ed, 1))
    const firstEnd = ed.state.doc.child(0).content.size
    ed.commands.deleteRange({ from: firstEnd, to: firstEnd + 1 })
    ;(notes(ed).find((row) => row.classList.contains("is-unreferenced"))!.querySelector(".editor-footnote__remove") as HTMLButtonElement).click()
    expect(listNode(ed).childCount).toBe(1)
    const lastEnd = ed.state.doc.child(1).content.size + ed.state.doc.child(0).nodeSize
    ed.commands.deleteRange({ from: lastEnd, to: lastEnd + 1 })
    ;(notes(ed)[0].querySelector(".editor-footnote__remove") as HTMLButtonElement).click()
    expect(blockTypes(ed)).toEqual(["paragraph", "paragraph"])
  })

  it("refuses to remove a note something refers to", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    expect(ed.commands.removeFootnote(noteIds(ed)[0])).toBe(false)
    expect(listNode(ed).childCount).toBe(1)
  })

  it("the stored doc keeps the note", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    typeInNote(ed, "still here")
    const end = ed.state.doc.child(0).content.size
    ed.commands.deleteRange({ from: end, to: end + 1 })
    const doc = pmToBlockDoc(ed.state.doc)
    expect(() => validateBlockDoc(doc)).not.toThrow()
    const list = Object.values(doc.blocks).find((b) => b.type === "footnotes")!
    expect((doc.blocks[list.children![0]].attrs as any).text).toBe("still here")
  })
})

describe("a note deleted while its reference remains", () => {
  it("shows the reference as missing, with no number, and the rest renumber", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    insertAt(ed, endOf(ed, 1))
    const list = findFootnotesList(ed.state.doc)!
    const first = list.node.child(0)
    ed.view.dispatch(ed.state.tr.delete(list.pos + 1, list.pos + 1 + first.nodeSize))
    const [missing, live] = refs(ed)
    expect(missing.dataset.footnoteMissing).toBe("true")
    expect(missing.dataset.footnoteNumber).toBeUndefined()
    expect(missing.getAttribute("aria-label")).toBe("Footnote missing")
    expect(live.dataset.footnoteNumber).toBe("1")
  })

  it("keeps the reference storable", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    const list = findFootnotesList(ed.state.doc)!
    ed.view.dispatch(ed.state.tr.delete(list.pos, list.pos + list.node.nodeSize))
    expect(() => validateBlockDoc(pmToBlockDoc(ed.state.doc))).not.toThrow()
  })
})

describe("duplicating a block with a reference", () => {
  it("gives the copy a reference to the same note, sharing its number", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    typeInNote(ed, "shared")
    const before = noteIds(ed)
    const block = topLevelBlockAt(ed.state.doc, 0)!
    expect(duplicateBlock(ed, refOf(block))).not.toBeNull()
    expect(noteIds(ed)).toEqual(before)
    expect(footnoteUses(ed.state.doc).get(before[0])).toHaveLength(2)
    expect(refs(ed).map((el) => el.dataset.footnoteNumber)).toEqual(["1", "1"])
    expect(ed.state.doc.child(0).attrs["data-block-id"]).not.toBe(ed.state.doc.child(1).attrs["data-block-id"])
    expect(() => validateBlockDoc(pmToBlockDoc(ed.state.doc))).not.toThrow()
  })
})

describe("what can't be done to the list", () => {
  it("has no gutter, block menu or drag: neither the list nor a note is an editor block", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    const list = listNode(ed)
    expect(isEditorBlock(list, ed.state.doc)).toBe(false)
    expect(isEditorBlock(list.child(0), list)).toBe(false)
    expect(editorBlockAtSelection(ed.state)).toBeNull()
  })

  it("the trailing-node extension adds no paragraph after the list", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 1))
    expect(ed.state.doc.lastChild!.type.name).toBe("footnotes")
  })

  it("a paragraph is still added after everything else", () => {
    const ed = makeEditor("<blockquote><p>x</p></blockquote>")
    ed.commands.setTextSelection(2)
    ed.commands.insertContent("y")
    expect(ed.state.doc.lastChild!.type.name).toBe("paragraph")
  })

  it("deleting a post's only other block leaves a line to type in", () => {
    const ed = makeEditor("<hr><p>x</p>")
    ed.commands.setTextSelection(endOf(ed, 1))
    ed.commands.insertFootnote()
    ed.view.dispatch(ed.state.tr.delete(ed.state.doc.child(0).nodeSize, ed.state.doc.child(0).nodeSize + ed.state.doc.child(1).nodeSize))
    expect(blockTypes(ed)).toEqual(["horizontalRule", "footnotes"])
    const block = topLevelBlockAt(ed.state.doc, 0)!
    ed.view.dispatch(deleteBlockTr(ed.state, { ...block, holder: ed.state.doc, holderPos: -1 })!)
    expect(blockTypes(ed)).toEqual(["paragraph", "footnotes"])
  })

  it("Delete at the end of the last paragraph doesn't select the list", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 1))
    ed.commands.setTextSelection(endOf(ed, 1))
    press(ed, "Delete")
    expect(ed.state.selection).toBeInstanceOf(TextSelection)
    expect(blockTypes(ed)).toEqual(["paragraph", "paragraph", "footnotes"])
  })

  it("the slash menu isn't offered in a note", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    expect(ed.state.selection.$from.parent.type.name).toBe("footnote")
  })
})

describe("keys", () => {
  it("↵ in a note goes back to right after its reference, without splitting it", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    typeInNote(ed, "text")
    press(ed, "Enter")
    expect(listNode(ed).childCount).toBe(1)
    expect(ed.state.selection.$from.parent).toBe(ed.state.doc.child(0))
    expect(ed.state.selection.$from.nodeBefore?.type.name).toBe("footnoteRef")
  })

  it("Esc in a note goes back too", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    press(ed, "Escape")
    expect(ed.state.selection.$from.nodeBefore?.type.name).toBe("footnoteRef")
  })

  it("↵ on a selected reference goes to its note", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    typeInNote(ed, "abc")
    const refPos = ed.state.doc.child(0).content.size
    ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, refPos)))
    press(ed, "Enter")
    expect(ed.state.selection.$from.parent.type.name).toBe("footnote")
    expect(ed.state.selection.$from.parentOffset).toBe(3)
  })

  it("↵ in an unreferenced note stays put and never splits", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    const end = ed.state.doc.child(0).content.size
    ed.commands.deleteRange({ from: end, to: end + 1 })
    const list = findFootnotesList(ed.state.doc)!
    ed.commands.setTextSelection(list.pos + 2)
    press(ed, "Enter")
    expect(listNode(ed).childCount).toBe(1)
  })

  it("⌫ at the start of a note never joins it to the one before", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    insertAt(ed, endOf(ed, 1))
    const list = findFootnotesList(ed.state.doc)!
    ed.commands.setTextSelection(list.pos + 1 + list.node.child(0).nodeSize + 1)
    press(ed, "Backspace")
    expect(listNode(ed).childCount).toBe(2)
  })

  it("Delete at the end of a note never joins the next one into it", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    insertAt(ed, endOf(ed, 1))
    const list = findFootnotesList(ed.state.doc)!
    ed.commands.setTextSelection(list.pos + 2)
    press(ed, "Delete")
    expect(listNode(ed).childCount).toBe(2)
  })

  it("clicking a number goes to its note; ↩ comes back", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    ed.commands.setTextSelection(1)
    const pos = ed.state.doc.child(0).content.size + 1
    const node = ed.state.doc.nodeAt(pos - 1)!
    ed.view.someProp("handleClickOn", (handler) => handler(ed.view, pos - 1, node, pos - 1, new MouseEvent("click"), true))
    expect(ed.state.selection.$from.parent.type.name).toBe("footnote")
    ;(notes(ed)[0].querySelector(".editor-footnote__back") as HTMLButtonElement).click()
    expect(ed.state.selection.$from.nodeBefore?.type.name).toBe("footnoteRef")
    expect(notes(ed)[0].querySelector(".editor-footnote__back")!.getAttribute("aria-label")).toBe("Back to reference 1")
  })
})

describe("paste", () => {
  const clipboardOf = (ed: Editor, from: number, to: number) => {
    const slice = ed.state.doc.slice(from, to, true)
    const host = document.createElement("div")
    host.appendChild(DOMSerializer.fromSchema(ed.schema).serializeFragment(slice.content))
    return host.innerHTML
  }
  const pasteEvent = () => new Event("paste") as ClipboardEvent
  const inSameDoc = (ed: Editor) => {
    ed.commands.setTextSelection(endOf(ed, 1))
    return ed
  }

  it("a pasted reference keeps pointing at its note in this post: two references, one number", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    const html = clipboardOf(ed, 0, ed.state.doc.child(0).nodeSize)
    expect(html).toContain("footnote-ref")
    ed.view.pasteHTML(html, pasteEvent())
    inSameDoc(ed)
    expect(footnoteUses(ed.state.doc).get(noteIds(ed)[0])).toHaveLength(2)
    expect(refs(ed).map((el) => el.dataset.footnoteNumber)).toEqual(["1", "1"])
  })

  it("a reference from another post has no note here: it's left out and the text stays", () => {
    const ed = makeEditor()
    ed.commands.setTextSelection(endOf(ed, 0))
    ed.view.pasteHTML('<p>before<sup data-type="footnote-ref" data-footnote-id="note-from-elsewhere"></sup>after</p>', pasteEvent())
    expect(ed.state.doc.child(0).textContent).toContain("beforeafter")
    expect(JSON.stringify(ed.state.doc.toJSON())).not.toContain("footnoteRef")
  })

  it("a cut and paste reattaches: the note survives and the reference comes back", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    const id = noteIds(ed)[0]
    const html = clipboardOf(ed, 0, ed.state.doc.child(0).nodeSize)
    ed.view.dispatch(ed.state.tr.delete(0, ed.state.doc.child(0).nodeSize))
    expect(footnoteUses(ed.state.doc).has(id)).toBe(false)
    ed.commands.setTextSelection(endOf(ed, 0))
    ed.view.pasteHTML(html, pasteEvent())
    expect(footnoteUses(ed.state.doc).get(id)).toHaveLength(1)
  })

  it("pasting over the note's own list drops the reference", () => {
    const ed = makeEditor()
    insertAt(ed, endOf(ed, 0))
    const state = ed.view.state
    const everything = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 2)))
    const ref = ed.schema.nodes.footnoteRef.create({ footnoteId: noteIds(ed)[0] })
    const slice = new Slice(Fragment.from(ed.schema.nodes.paragraph.create(null, ref)), 0, 0)
    const kept = keepKnownFootnoteRefs(slice, everything)
    expect(kept.content.firstChild!.childCount).toBe(0)
  })

  it("a copied list can't become a second list; its text pastes as text", () => {
    const html = '<section data-type="footnotes"><h3>Footnotes</h3><div><div data-type="footnote" data-block-id="note-000001">Text</div></div></section>'
    const clean = sanitizePastedHTML(html)
    expect(clean).not.toContain('data-type="footnote"')
    expect(clean).not.toContain("note-000001")
    expect(clean).toContain("Text")
    const ed = makeEditor()
    ed.commands.setTextSelection(endOf(ed, 0))
    ed.view.pasteHTML(html, pasteEvent())
    expect(blockTypes(ed)).not.toContain("footnotes")
    expect(ed.state.doc.textContent).toContain("Text")
  })

  it("keeps the reference's type and id only on a sup", () => {
    expect(sanitizePastedHTML('<sup data-type="footnote-ref" data-footnote-id="note-000001" onclick="x" data-other="y"></sup>')).toBe('<sup data-type="footnote-ref" data-footnote-id="note-000001"></sup>')
    expect(sanitizePastedHTML('<sup data-type="footnote-ref" data-footnote-id="bad"></sup>')).toBe('<sup data-type="footnote-ref"></sup>')
    expect(sanitizePastedHTML('<span data-type="footnote-ref" data-footnote-id="note-000001">x</span>')).toBe("x")
  })

  it("a pasted sup is still superscript when it isn't a reference", () => {
    const ed = makeEditor()
    ed.commands.setTextSelection(endOf(ed, 0))
    ed.view.pasteHTML("<p>x<sup>2</sup></p>", pasteEvent())
    expect(JSON.stringify(ed.state.doc.toJSON())).toContain("superscript")
  })
})
