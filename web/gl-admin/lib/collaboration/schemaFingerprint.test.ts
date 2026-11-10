import { describe, it, expect } from "vitest"
import { createHash } from "node:crypto"
import { Extension, getSchema, Mark, Node } from "@tiptap/core"
import { Schema, type MarkSpec, type NodeSpec } from "prosemirror-model"
import { TableCell, TableHeader } from "@tiptap/extension-table"
import { Details } from "../../components/editor/extensions/DetailsBlock"
import Subscript from "@tiptap/extension-subscript"
import Superscript from "@tiptap/extension-superscript"
import { getCoreSchema, schemaExtensions } from "./schema"
import { Group } from "../../components/editor/extensions/GroupBlock"
import { Footnote } from "../../components/editor/extensions/FootnotesBlock"
import { GlTable, GlTableRow, TableBlock, TableCaption } from "../../components/editor/extensions/TableBlock"
import {
  decodeCollabAuthToken,
  describeSchemaForFingerprint,
  encodeCollabAuthToken,
  schemaFingerprint,
  sha256Hex,
} from "./schemaFingerprint"

// #416. What changes the fingerprint and what doesn't is decided (and documented) in
// schemaFingerprint.ts `describeSchemaForFingerprint`: anything that changes which
// documents the schema builds (and so what y-tiptap would delete) changes it; what
// ProseMirror treats as equal doesn't.

type Spec = { nodes: Record<string, NodeSpec>; marks: Record<string, MarkSpec> }

function baseSpec(): Spec {
  return {
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "inline*", attrs: { align: { default: null }, id: { default: "x" } } },
      heading: { group: "block heading", content: "inline*", marks: "bold italic", attrs: { level: { default: 1 }, meta: { default: { a: 1, b: [1, 2] } } } },
      image: { group: "block", attrs: { src: {}, alt: { default: null } } },
      figure: { group: "block", content: "(image | paragraph)+" },
      text: { group: "inline" },
    },
    marks: {
      bold: {},
      italic: { excludes: "italic code" },
      code: {},
      link: { attrs: { href: {}, title: { default: null } } },
    },
  }
}

const fingerprintOf = (spec: Spec) => schemaFingerprint(new Schema(spec))
const BASE = fingerprintOf(baseSpec())

function changed(edit: (spec: Spec) => void): string {
  const spec = structuredClone(baseSpec())
  edit(spec)
  return fingerprintOf(spec)
}

/** `record` with its keys in reverse order. */
const reversed = <T,>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).reverse())

describe("schemaFingerprint (#416)", () => {
  it("is a SHA-256 hex digest, the same as node:crypto's", () => {
    for (const text of ["", "abc", "a".repeat(55), "b".repeat(56), "c".repeat(64), "é ü 文字 🙂", describeSchemaForFingerprint(getCoreSchema())]) {
      expect(sha256Hex(text), JSON.stringify(text.slice(0, 20))).toBe(createHash("sha256").update(text, "utf8").digest("hex"))
    }
    expect(BASE).toMatch(/^[0-9a-f]{64}$/)
  })

  it("is the same for the same schema built twice", () => {
    expect(fingerprintOf(baseSpec())).toBe(BASE)
    const rebuilt = getSchema(Object.values(schemaExtensions({ collaborating: true })))
    expect(rebuilt).not.toBe(getCoreSchema())
    expect(schemaFingerprint(rebuilt)).toBe(schemaFingerprint(getCoreSchema()))
  })

  describe("changes when the documents the schema builds change", () => {
    const cases: [string, (spec: Spec) => void][] = [
      ["a node is added", (s) => void (s.nodes.sidenote = { group: "block", content: "inline*" })],
      ["a node is removed", (s) => void delete s.nodes.heading],
      ["a node is renamed", (s) => ((s.nodes.title = s.nodes.heading), delete s.nodes.heading)],
      ["a mark is added", (s) => void (s.marks.highlight = { attrs: { color: { default: "yellow" } } })],
      ["a mark is removed", (s) => void delete s.marks.link],
      ["a node attr is added", (s) => void (s.nodes.paragraph.attrs!.blockColor = { default: null })],
      ["a node attr is removed", (s) => void delete s.nodes.image.attrs!.alt],
      ["a mark attr is added", (s) => void (s.marks.link.attrs!.target = { default: null })],
      ["an attr default changes", (s) => void (s.nodes.heading.attrs!.level = { default: 2 })],
      ["a nested attr default changes", (s) => void (s.nodes.heading.attrs!.meta = { default: { a: 1, b: [2, 1] } })],
      ["an attr default goes from null to undefined", (s) => void (s.nodes.paragraph.attrs!.align = { default: undefined })],
      ["an attr becomes required", (s) => void (s.nodes.heading.attrs!.level = {})],
      ["an attr gets a validate rule", (s) => void (s.nodes.paragraph.attrs!.align = { default: null, validate: "string|null" })],
      ["a content expression changes", (s) => void (s.nodes.doc.content = "block*")],
      ["the alternatives of a content expression are reordered", (s) => void (s.nodes.figure.content = "(paragraph | image)+")],
      ["a node joins a group", (s) => void (s.nodes.image.group = "block media")],
      ["a node's allowed marks change", (s) => void (s.nodes.heading.marks = "bold")],
      ["a mark's excludes change", (s) => void (s.marks.italic.excludes = "italic")],
      ["the node types are reordered (the first of a group fills content)", (s) => {
        const { heading, ...rest } = s.nodes
        s.nodes = { doc: rest.doc, heading, ...rest }
      }],
      ["the mark types are reordered (mark rank)", (s) => void (s.marks = reversed(s.marks))],
    ]
    it.each(cases)("%s", (_name, edit) => {
      expect(changed(edit)).not.toBe(BASE)
    })

    it("a different top node", () => {
      const spec = baseSpec()
      expect(schemaFingerprint(new Schema({ ...spec, nodes: { ...spec.nodes, page: { content: "block+" } }, topNode: "page" }))).not.toBe(
        schemaFingerprint(new Schema({ ...spec, nodes: { ...spec.nodes, page: { content: "block+" } } })),
      )
    })
  })

  describe("doesn't change for what ProseMirror treats as equal", () => {
    const cases: [string, (spec: Spec) => void][] = [
      ["attrs listed in another order", (s) => {
        s.nodes.paragraph.attrs = reversed(s.nodes.paragraph.attrs!)
        s.marks.link.attrs = reversed(s.marks.link.attrs!)
      }],
      ["spec keys in another order", (s) => void (s.nodes.heading = reversed(s.nodes.heading as Record<string, unknown>) as NodeSpec)],
      ["keys of a default value in another order", (s) => void (s.nodes.heading.attrs!.meta = { default: { b: [1, 2], a: 1 } })],
      ["groups listed in another order", (s) => void (s.nodes.heading.group = "heading  block")],
      ["a node's marks listed in another order", (s) => void (s.nodes.heading.marks = "italic bold")],
      ["a mark's excludes listed in another order", (s) => void (s.marks.italic.excludes = "code italic")],
      ["whitespace in a content expression", (s) => ((s.nodes.doc.content = " block + "), (s.nodes.figure.content = "( image|paragraph ) +"))],
      ["an explicit default equal to the implied one", (s) => void (s.marks.bold.excludes = "bold")],
      ["editing, parsing and rendering behaviour", (s) => {
        Object.assign(s.nodes.image, { atom: true, selectable: false, draggable: true, parseDOM: [{ tag: "img" }], toDOM: () => ["img"] })
        Object.assign(s.nodes.heading, { defining: true, isolating: true })
        Object.assign(s.marks.link, { inclusive: false, spanning: false, parseDOM: [{ tag: "a" }] })
      }],
      ["a custom spec key", (s) => void ((s.nodes.paragraph as Record<string, unknown>).glThemeBlock = { version: 2 })],
    ]
    it.each(cases)("%s", (_name, edit) => {
      expect(changed(edit)).toBe(BASE)
    })
  })

  describe("on the editor's real schema", () => {
    const core = schemaFingerprint(getCoreSchema())
    const withExtra = (...extra: Parameters<typeof getSchema>[0]) =>
      schemaFingerprint(getSchema([...Object.values(schemaExtensions({ collaborating: true })), ...extra]))

    it("a new node type (a new block) changes it", () => {
      const Sidenote = Node.create({ name: "sidenote", group: "block", content: "inline*", addAttributes: () => ({ "data-block-id": { default: null } }) })
      expect(withExtra(Sidenote)).not.toBe(core)
    })

    it("a new mark changes it", () => {
      expect(withExtra(Mark.create({ name: "spoiler" }))).not.toBe(core)
    })

    it("the inline marks (#418) changed it, each on its own, and their exclusions are in it", () => {
      // The schema as it was before #418: none of the three marks.
      const { highlight, superscript, subscript, ...rest } = schemaExtensions({ collaborating: true })
      const before = getSchema(Object.values(rest))
      for (const name of ["highlight", "superscript", "subscript"]) {
        expect(before.marks[name], name).toBeUndefined()
        expect(getCoreSchema().marks[name], name).toBeDefined()
      }
      const old = schemaFingerprint(before)
      expect(old).not.toBe(core)
      // A stale tab with either part still differs from both (superscript and subscript
      // name each other in `excludes`, so neither builds without the other).
      for (const added of [{ highlight }, { superscript, subscript }]) {
        const one = schemaFingerprint(getSchema(Object.values({ ...rest, ...added })))
        expect(one, Object.keys(added).join("+")).not.toBe(old)
        expect(one, Object.keys(added).join("+")).not.toBe(core)
      }
      // A tab whose superscript and subscript could be combined builds other docs: refused.
      // (TipTap's own Superscript and Subscript, which only exclude themselves.)
      const combinable = getSchema(Object.values({ ...rest, highlight, superscript: Superscript, subscript: Subscript }))
      expect(combinable.marks.superscript.excludes(combinable.marks.subscript)).toBe(false)
      expect(schemaFingerprint(combinable)).not.toBe(core)
      // And one whose highlight has a colour attr (multicolor) too.
      const multicolor = getSchema(Object.values({ ...rest, highlight: highlight.configure({ multicolor: true }), superscript, subscript }))
      expect(multicolor.marks.highlight.spec.attrs).toHaveProperty("color")
      expect(schemaFingerprint(multicolor)).not.toBe(core)
    })

    it("a new global attribute changes it", () => {
      const Indent = Extension.create({
        name: "indent",
        addGlobalAttributes: () => [{ types: ["paragraph"], attributes: { indent: { default: 0 } } }],
      })
      expect(withExtra(Indent)).not.toBe(core)
    })

    it("the Group block (#414) changed it: a new node type and a wider doc", () => {
      // The schema as it was before #414: no Group, and StarterKit's `block+` doc.
      const { group: _group, document: _document, ...rest } = schemaExtensions({ collaborating: true })
      const OldDocument = Node.create({ name: "doc", topNode: true, content: "block+" })
      const before = getSchema([OldDocument, ...Object.values(rest)])
      expect(before.nodes.group).toBeUndefined()
      expect(getCoreSchema().nodes.group).toBeDefined()
      expect(schemaFingerprint(before)).not.toBe(core)
      // Each half on its own changes it too: a stale tab with either would be refused.
      const onlyGroup = getSchema([OldDocument, ...Object.values({ ...rest, group: _group })])
      expect(schemaFingerprint(onlyGroup)).not.toBe(schemaFingerprint(before))
      expect(schemaFingerprint(onlyGroup)).not.toBe(core)
    })

    it("the callout, pull quote and to-do list (#419) changed it, each on its own", () => {
      // The schema as it was before #419: none of the four node types.
      const { callout, pullQuote, todoList, todoItem, ...rest } = schemaExtensions({ collaborating: true })
      const before = getSchema(Object.values(rest))
      for (const name of ["callout", "pullQuote", "taskList", "taskItem"]) {
        expect(before.nodes[name], name).toBeUndefined()
        expect(getCoreSchema().nodes[name], name).toBeDefined()
      }
      const old = schemaFingerprint(before)
      expect(old).not.toBe(core)
      // A stale tab with any one of them (or the to-do pair) still differs from both.
      for (const added of [{ callout }, { pullQuote }, { todoList, todoItem }]) {
        const one = schemaFingerprint(getSchema(Object.values({ ...rest, ...added })))
        expect(one, Object.keys(added).join("+")).not.toBe(old)
        expect(one, Object.keys(added).join("+")).not.toBe(core)
      }
      // The attrs the store reads are in it: a tab whose callout has no tone is refused too.
      const toneless = getSchema(Object.values({ ...rest, callout: callout.extend({ addAttributes: () => ({}) }), pullQuote, todoList, todoItem }))
      expect(schemaFingerprint(toneless)).not.toBe(core)
    })

    it("the table (#420) changed it: new node types, and a doc and a group that name the table block", () => {
      // The schema as it was before #420: no table nodes (nor #421's details), `(block | group)+`
      // doc, `block+` group.
      const { table: _table, document: _document, group: _group, details: _details, columns: _columns, cover: _cover, mediaText: _mediaText, ...rest } = schemaExtensions({ collaborating: true })
      const OldDocument = Node.create({ name: "doc", topNode: true, content: "(block | group)+" })
      const OldGroup = Group.extend({ content: "block+" })
      const before = getSchema([OldDocument, ...Object.values({ ...rest, group: OldGroup })])
      expect(before.nodes.tableBlock).toBeUndefined()
      for (const name of ["tableBlock", "table", "tableRow", "tableCell", "tableCaption"]) {
        expect(getCoreSchema().nodes[name], name).toBeDefined()
      }
      expect(schemaFingerprint(before)).not.toBe(core)
      // A stale tab whose cells took any block (TipTap's default `block+`) is refused too.
      expect(getCoreSchema().nodes.tableCell.spec.content).toBe("paragraph+")
      const blockCells = getSchema([
        ...Object.values({ ...schemaExtensions({ collaborating: true }), table: TableBlock.extend({ addExtensions: () => [GlTable, GlTableRow, TableHeader, TableCell, TableCaption] }) }),
      ])
      expect(blockCells.nodes.tableCell.spec.content).toBe("block+")
      expect(schemaFingerprint(blockCells)).not.toBe(core)
    })

    it("details (#421) changed it: new node types, and a doc and a group that name details", () => {
      // The schema as it was before #421 (after #423): no details nodes, a doc and a group without them.
      const { document: _document, group: _group, details, columns: _columns, cover: _cover, mediaText: _mediaText, ...rest } = schemaExtensions({ collaborating: true })
      const OldDocument = Node.create({ name: "doc", topNode: true, content: "(block | tableBlock | video | audio | file | group)+" })
      const OldGroup = Group.extend({ content: "(block | tableBlock | video | audio | file)+" })
      const before = getSchema([OldDocument, ...Object.values({ ...rest, group: OldGroup })])
      expect(before.nodes.details).toBeUndefined()
      for (const name of ["details", "detailsSummary"]) expect(getCoreSchema().nodes[name], name).toBeDefined()
      const old = schemaFingerprint(before)
      expect(old).not.toBe(core)
      // A stale tab with the nodes but the old doc and group differs from both.
      const nodesOnly = schemaFingerprint(getSchema([OldDocument, ...Object.values({ ...rest, group: OldGroup, details })]))
      expect(nodesOnly).not.toBe(old)
      expect(nodesOnly).not.toBe(core)
      // The open attr is in it: a tab whose details has none is refused too.
      const openless = getSchema(Object.values({ ...schemaExtensions({ collaborating: true }), details: details.extend({ addAttributes: () => ({}) }) }))
      expect(schemaFingerprint(openless)).not.toBe(core)
    })

    it("the gallery (#424) changed it: new node types, and a doc that names it", () => {
      // The schema as it was before #424: no gallery nodes, a doc without it.
      const { document: _document, gallery, ...rest } = schemaExtensions({ collaborating: true })
      const OldDocument = Node.create({ name: "doc", topNode: true, content: "(block | tableBlock | video | audio | file | embed | group | details)+" })
      const before = getSchema([OldDocument, ...Object.values(rest)])
      expect(before.nodes.gallery).toBeUndefined()
      for (const name of ["gallery", "galleryCaption"]) expect(getCoreSchema().nodes[name], name).toBeDefined()
      const old = schemaFingerprint(before)
      expect(old).not.toBe(core)
      // A stale tab with the nodes but the old doc differs from both.
      const nodesOnly = schemaFingerprint(getSchema([OldDocument, ...Object.values({ ...rest, gallery })]))
      expect(nodesOnly).not.toBe(old)
      expect(nodesOnly).not.toBe(core)
      // The columns attr is in it: a tab whose gallery has none is refused too.
      const columnless = getSchema(Object.values({ ...schemaExtensions({ collaborating: true }), gallery: gallery.extend({ addAttributes: () => ({}) }) }))
      expect(schemaFingerprint(columnless)).not.toBe(core)
    })

    it("the embed block (#425) changed it: a node type, named by the doc and a group", () => {
      const { embed, embedCommands: _commands, document: _document, group: _group, details: _details, columns: _columns, cover: _cover, mediaText: _mediaText, ...rest } = schemaExtensions({ collaborating: true })
      const flow = "(block | tableBlock | video | audio | file)"
      const OldDocument = Node.create({ name: "doc", topNode: true, content: `(block | tableBlock | video | audio | file | group | details)+` })
      const OldGroup = _group.extend({ content: `(${flow.slice(1, -1)} | details)+` })
      const OldDetails = _details.extend({ content: `detailsSummary ${flow}+` })
      const before = getSchema([...Object.values(rest), OldDocument, OldGroup, OldDetails])
      expect(Object.keys(before.nodes)).not.toContain("embed")
      const after = getSchema(Object.values(schemaExtensions({ collaborating: true })))
      expect(schemaFingerprint(before)).not.toBe(schemaFingerprint(after))
      expect(after.nodes.embed).toBeDefined()
      expect(embed).toBeDefined()
    })

    it("custom HTML (#428) changed it: a node type the doc and its containers name, with its one attr", () => {
      const after = getCoreSchema()
      expect(after.nodes.html).toBeDefined()
      expect(describeSchemaForFingerprint(after)).toContain("html")
      // A stale tab that didn't know the attr would rewrite the element and lose the id.
      const spec = after.spec.nodes.get("html")!
      const { snippetId: _snippetId, ...attrs } = spec.attrs as Record<string, unknown>
      const withoutSnippetId = new Schema({
        nodes: after.spec.nodes.update("html", { ...spec, attrs: attrs as NonNullable<typeof spec.attrs> }),
        marks: after.spec.marks,
        topNode: after.spec.topNode,
      })
      expect(schemaFingerprint(withoutSnippetId)).not.toBe(schemaFingerprint(after))
    })

    it("columns, buttons and the spacer (#426) changed it: new node types, named by the doc, a group and a details", () => {
      // The schema as it was before #426: none of them, and a doc, group and details without them.
      const { columns, buttons, spacer, document: _document, group: _group, details: _details, cover: _cover, mediaText: _mediaText, ...rest } = schemaExtensions({ collaborating: true })
      const OldDocument = Node.create({ name: "doc", topNode: true, content: "(block | tableBlock | video | audio | file | embed | group | details | gallery)+" })
      const OldGroup = Group.extend({ content: "(block | tableBlock | video | audio | file | embed | details)+" })
      const OldDetails = Details.extend({ content: "detailsSummary (block | tableBlock | video | audio | file | embed)+" })
      const before = getSchema([OldDocument, ...Object.values({ ...rest, group: OldGroup, details: OldDetails })])
      for (const name of ["columns", "column", "buttons", "button", "spacer"]) {
        expect(before.nodes[name], name).toBeUndefined()
        expect(getCoreSchema().nodes[name], name).toBeDefined()
      }
      expect(schemaFingerprint(before)).not.toBe(core)
      // A tab whose button row has no align, or whose spacer no size, is refused too.
      const alignless = getSchema(Object.values({ ...schemaExtensions({ collaborating: true }), buttons: buttons.extend({ addAttributes: () => ({}) }) }))
      expect(schemaFingerprint(alignless)).not.toBe(core)
      const sizeless = getSchema(Object.values({ ...schemaExtensions({ collaborating: true }), spacer: spacer.extend({ addAttributes: () => ({}) }) }))
      expect(schemaFingerprint(sizeless)).not.toBe(core)
      const layoutless = getSchema(Object.values({ ...schemaExtensions({ collaborating: true }), columns: columns.extend({ addAttributes: () => ({}) }) }))
      expect(schemaFingerprint(layoutless)).not.toBe(core)
      // The column count isn't in it (y-tiptap deletes what fails a content check, #426).
      expect(getCoreSchema().nodes.columns.spec.content).toBe("column+")
    })

    it("cover and media & text (#427) changed it: two node types, named by the doc and a group", () => {
      // The schema as it was before #427: neither of them, and a doc and group that name neither.
      const { cover, mediaText, coverMediaCommands: _commands, document: _document, group: _group, ...rest } = schemaExtensions({ collaborating: true })
      const OldDocument = Node.create({ name: "doc", topNode: true, content: "(block | tableBlock | video | audio | file | embed | buttons | spacer | group | details | gallery | columns)+" })
      const OldGroup = Group.extend({ content: "(block | tableBlock | video | audio | file | embed | buttons | spacer | details | columns)+" })
      const before = getSchema([OldDocument, ...Object.values({ ...rest, group: OldGroup })])
      for (const name of ["cover", "mediaText"]) {
        expect(before.nodes[name], name).toBeUndefined()
        expect(getCoreSchema().nodes[name], name).toBeDefined()
      }
      expect(schemaFingerprint(before)).not.toBe(core)
      // A tab whose cover or media & text lacks an attribute is refused too.
      const overlayless = getSchema(Object.values({ ...schemaExtensions({ collaborating: true }), cover: cover.extend({ addAttributes: () => ({}) }) }))
      expect(schemaFingerprint(overlayless)).not.toBe(core)
      const positionless = getSchema(Object.values({ ...schemaExtensions({ collaborating: true }), mediaText: mediaText.extend({ addAttributes: () => ({}) }) }))
      expect(schemaFingerprint(positionless)).not.toBe(core)
      // May be empty in the schema, on purpose: y-tiptap deletes what fails a content check.
      expect(getCoreSchema().nodes.cover.spec.content).toMatch(/\*$/)
      expect(getCoreSchema().nodes.mediaText.spec.content).toMatch(/\*$/)
    })

    it("the video, audio and file blocks (#423) changed it: three node types, named by the doc and a group", () => {
      // The schema as it was before #423 (and #421): no media nodes, no details, and the doc and the group name
      // only the table next to `block`.
      const { video, audio, file, mediaCommands: _commands, document: _document, group: _group, details: _details, columns: _columns, cover: _cover, mediaText: _mediaText, ...rest } = schemaExtensions({ collaborating: true })
      const OldDocument = Node.create({ name: "doc", topNode: true, content: "(block | tableBlock | group)+" })
      const OldGroup = Group.extend({ content: "(block | tableBlock)+" })
      const before = getSchema([OldDocument, ...Object.values({ ...rest, group: OldGroup })])
      for (const name of ["video", "audio", "file"]) {
        expect(before.nodes[name], name).toBeUndefined()
        expect(getCoreSchema().nodes[name], name).toBeDefined()
      }
      const old = schemaFingerprint(before)
      expect(old).not.toBe(core)
      // A stale tab with only some of them (a bundle from midway) still differs from both.
      for (const added of [{ video }, { audio }, { file }]) {
        const one = schemaFingerprint(getSchema([OldDocument, ...Object.values({ ...rest, group: OldGroup, ...added })]))
        expect(one, Object.keys(added)[0]).not.toBe(old)
        expect(one, Object.keys(added)[0]).not.toBe(core)
      }
      // Their attrs are part of it: a file block without its label attr is another schema.
      const noLabel = getSchema(Object.values({ ...schemaExtensions({ collaborating: true }), file: file.extend({ addAttributes: () => ({ mediaId: { default: null } }) }) }))
      expect(schemaFingerprint(noLabel)).not.toBe(core)
    })

    it("footnotes (#422) changed it: three new node types, one in every text block, and a wider doc", () => {
      const { footnoteRef, footnotes, document, ...rest } = schemaExtensions({ collaborating: true })
      const OldDocument = document.extend({ content: (document.config.content as string).replace(" | footnotes", "") })
      const before = getSchema(Object.values({ ...rest, document: OldDocument }))
      for (const name of ["footnoteRef", "footnotes", "footnote"]) {
        expect(before.nodes[name], name).toBeUndefined()
        expect(getCoreSchema().nodes[name], name).toBeDefined()
      }
      expect(getCoreSchema().nodes.footnoteRef.isInline && getCoreSchema().nodes.footnoteRef.isAtom).toBe(true)
      expect(schemaFingerprint(before)).not.toBe(core)
      // Each piece on its own: a tab with the list but no reference would delete the references.
      expect(schemaFingerprint(getSchema(Object.values({ ...rest, document, footnotes: footnotes.extend({}) , footnoteRef: footnoteRef.extend({ addAttributes: () => ({}) }) })))).not.toBe(core)
      // "One list, last" isn't in the schema, on purpose (blocks-spec/footnotes.ts).
      expect(getCoreSchema().topNodeType.spec.content).toMatch(/^\(.*\| footnotes\b.*\)\+$/)
    })

    it("the inline nodes (#320) changed it, each on its own, and their attrs are in it", () => {
      // The schema as it was before #320: no mention, content link or date chip.
      // A footnote's content names them (#422), so the old schema's notes can't.
      const { mention, contentLink, dateChip, footnotes, ...others } = schemaExtensions({ collaborating: true })
      const rest = { ...others, footnotes: footnotes.extend({ addExtensions: () => [Footnote.extend({ content: "text*" })] }) }
      const before = getSchema(Object.values(rest))
      for (const name of ["mention", "contentLink", "dateChip"]) {
        expect(before.nodes[name], name).toBeUndefined()
        expect(getCoreSchema().nodes[name], name).toBeDefined()
        expect(getCoreSchema().nodes[name].isInline && getCoreSchema().nodes[name].isAtom, name).toBe(true)
      }
      const old = schemaFingerprint(before)
      expect(old).not.toBe(core)
      // A stale tab with any one of them still differs from both: y-tiptap would delete
      // the others a newer peer inserts (rule 10), so it is refused.
      for (const added of [{ mention }, { contentLink }, { dateChip }]) {
        const one = schemaFingerprint(getSchema(Object.values({ ...rest, ...added })))
        expect(one, Object.keys(added)[0]).not.toBe(old)
        expect(one, Object.keys(added)[0]).not.toBe(core)
      }
      // The attrs the API reads are in it: a tab whose date chip has no `reminder` is refused too.
      const noReminder = getSchema(Object.values({ ...rest, mention, contentLink, dateChip: dateChip.extend({ addAttributes: () => ({ date: { default: null }, time: { default: null } }) }) }))
      expect(schemaFingerprint(noReminder)).not.toBe(core)
    })

    it("an extension without schema doesn't", () => {
      expect(withExtra(Extension.create({ name: "shortcuts", addKeyboardShortcuts: () => ({}) }))).toBe(core)
    })
  })
})

describe("the collab auth token (#416)", () => {
  it("carries the ticket and the fingerprint", () => {
    const token = encodeCollabAuthToken("v4.public.abc", "f".repeat(64))
    expect(decodeCollabAuthToken(token)).toEqual({ ticket: "v4.public.abc", schema: "f".repeat(64) })
  })

  it("reads a bare ticket (a client from before #416) as a ticket without a fingerprint", () => {
    expect(decodeCollabAuthToken("v4.public.abc")).toEqual({ ticket: "v4.public.abc", schema: null })
    expect(decodeCollabAuthToken("  v4.public.abc \n")).toEqual({ ticket: "v4.public.abc", schema: null })
  })

  it("reads anything malformed as no ticket", () => {
    for (const token of ['{"ticket":', "{}", '{"ticket":7,"schema":"x"}', undefined, null, 42]) {
      expect(decodeCollabAuthToken(token).ticket, String(token)).toBe("")
    }
    expect(decodeCollabAuthToken('{"ticket":"t","schema":""}')).toEqual({ ticket: "t", schema: null })
  })
})
