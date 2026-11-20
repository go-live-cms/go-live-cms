import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { installedThemeBlockEditors } from "@gl-admin/lib/theme-blocks/editorBlocks"
import {
  BLOCK_GROUPS,
  CORE_BLOCKS,
  ICONS,
  canInsert,
  catalogEntries,
  offeredIn,
  SITE_BLOCKS,
  flattenSections,
  isAdminOnly,
  matchEntry,
  menuEntries,
  searchCatalog,
  turnIntoEntries,
  type CatalogEntry,
} from "./catalog"
import { applyTurnInto, computeTurnIntoFromSelection } from "../utils/turnInto"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import { SITE_BLOCK_NODE_NAMES, siteBlockNodeAttrs, type SiteBlockType } from "@gl-admin/lib/blocks-spec"
import { holderAcceptsType } from "../utils/blockTree"
import { QUERY_NO_RESULTS_TEXT } from "../extensions/SiteBlocks"
import { currentTableSizePicker } from "../ui/TableSizePicker"
import { currentColumnsPicker } from "../ui/ColumnsPicker"

// The block catalog (#415): one list for the slash menu, the + menu and Turn into.

// insert and turnInto focus the editor, which scrolls the selection into view.
stubJsdomRangeLayout()

// Custom HTML (#428), the only Advanced block the design has.
const customHtml = CORE_BLOCKS.find((entry) => entry.id === "html")!
// The design's /vid example: the Video block (#423) and embeds the catalog doesn't have yet.
const video = (name: string, group: CatalogEntry["group"], keywords: string[] = []): CatalogEntry => ({
  id: name.toLowerCase(),
  type: name.toLowerCase(),
  name,
  group,
  keywords,
  icon: { path: ICONS.image },
  insert: () => {},
})
// The Embeds group's real entries (#425).
const withEmbeds = CORE_BLOCKS

const names = (entries: readonly CatalogEntry[]) => entries.map((e) => e.name)
const sectionNames = (query: string, entries: readonly CatalogEntry[] = CORE_BLOCKS) =>
  searchCatalog(entries, query).map((s) => [s.label, s.matches.map((m) => m.entry.name)])

describe("the catalog", () => {
  it("lists every core block once, in the design's groups and order", () => {
    expect(new Set(CORE_BLOCKS.map((e) => e.id)).size).toBe(CORE_BLOCKS.length)
    expect(sectionNames("")).toEqual([
      [
        "Text",
        [
          "Paragraph",
          "Heading 1",
          "Heading 2",
          "Heading 3",
          "Heading 4",
          "Heading 5",
          "Heading 6",
          "Bulleted list",
          "Numbered list",
          "To-do list",
          "Quote",
          "Pull quote",
          "Callout",
          "Code",
          "Table",
          "Details",
          "Footnote",
        ],
      ],
      ["Media", ["Image", "Gallery", "Video", "Audio", "File", "Cover", "Media & text"]],
      ["Layout", ["Divider", "Group", "Columns", "Buttons", "Spacer"]],
      ["Embeds", ["YouTube", "Vimeo", "X", "Embed a link"]],
      ["Advanced", ["Custom HTML"]],
    ])
    // Site (#488) is between Embeds and Advanced; a post's menus never show it (below).
    expect(BLOCK_GROUPS.map((g) => g.label)).toEqual(["Text", "Media", "Layout", "Embeds", "Site", "Advanced"])
  })

  it("holds every installed theme block, offered only while its theme is active", () => {
    const alert = installedThemeBlockEditors.find((e) => e.type === "theme:example/alert")!.entry
    expect(catalogEntries()).toContain(alert)
    expect(alert).toMatchObject({ name: "Alert", group: "text", theme: "example" })
    expect(menuEntries({ role: "editor", theme: "default" })).not.toContain(alert)
    expect(menuEntries({ role: "editor", theme: "example" })).toContain(alert)
    // A theme block is found by its keywords too (the old aliases).
    expect(matchEntry(alert, "warn")?.keyword).toBe("warning")
  })

  it("asks a slot whether it accepts each block (#414's nesting table)", () => {
    const flowOnly = menuEntries({ role: "admin", accepts: (e) => e.type !== "image" })
    expect(names(flowOnly)).not.toContain("Image")
    expect(names(flowOnly)).toContain("Paragraph")
  })
})

describe("search (names and keywords)", () => {
  it("/vid matches names and keywords, the match in bold: Video, then YouTube and Vimeo by 'video'", () => {
    const sections = searchCatalog(withEmbeds, "vid")
    expect(sections.map((s) => s.label)).toEqual(["Media", "Embeds"])
    const [videoMatch, youtube, vimeo] = flattenSections(sections)
    expect(videoMatch).toMatchObject({ entry: { name: "Video" }, nameMatch: [0, 3] })
    expect(youtube).toMatchObject({ entry: { name: "YouTube" }, keyword: "video" })
    expect(youtube.nameMatch).toBeUndefined()
    expect(vimeo).toMatchObject({ entry: { name: "Vimeo" }, keyword: "video" })
  })

  it("matches the start of any word of a name, case-insensitively, never the inside of one", () => {
    expect(matchEntry(CORE_BLOCKS.find((e) => e.id === "bullet-list")!, "LIST")?.nameMatch).toEqual([9, 13])
    expect(matchEntry(CORE_BLOCKS.find((e) => e.id === "heading-3")!, "3")?.nameMatch).toEqual([8, 9])
    // Paragrap|h| isn't a match for "h"; the headings are, and Divider by its keyword "hr".
    expect(flattenSections(searchCatalog(CORE_BLOCKS, "h")).map((m) => [m.entry.name, m.keyword])).toEqual([
      ["Heading 1", undefined],
      ["Heading 2", undefined],
      ["Heading 3", undefined],
      ["Heading 4", undefined],
      ["Heading 5", undefined],
      ["Heading 6", undefined],
      ["Cover", "hero"],
      ["Divider", "hr"],
      ["Custom HTML", undefined],
    ])
  })

  it("matches keywords by prefix and says which one", () => {
    expect(matchEntry(CORE_BLOCKS.find((e) => e.id === "heading-2")!, "h2")).toMatchObject({ keyword: "h2" })
    expect(matchEntry(CORE_BLOCKS.find((e) => e.id === "divider")!, "horizontal")).toMatchObject({ keyword: "horizontal rule" })
    expect(matchEntry(CORE_BLOCKS.find((e) => e.id === "image")!, "pho")).toMatchObject({ keyword: "photo" })
    // A name match wins over a keyword (no keyword shown).
    expect(matchEntry(CORE_BLOCKS.find((e) => e.id === "quote")!, "quo")).toEqual({ entry: expect.anything(), nameMatch: [0, 3] })
  })

  it("collapses spaces in the query (the + menu's field can hold them)", () => {
    expect(matchEntry(CORE_BLOCKS.find((e) => e.id === "numbered-list")!, "  numbered   li ")?.nameMatch).toEqual([0, 11])
  })

  it("finds nothing for /map, and leaves out empty groups", () => {
    expect(searchCatalog(CORE_BLOCKS, "map")).toEqual([])
    expect(sectionNames("code")).toEqual([
      ["Text", ["Code"]],
      // #425: CodePen, by keyword.
      ["Embeds", ["Embed a link"]],
    ])
  })

  it("has no item cap", () => {
    const many = Array.from({ length: 40 }, (_, i) => video(`Block ${i}`, "layout"))
    expect(flattenSections(searchCatalog(many, "block"))).toHaveLength(40)
    expect(flattenSections(searchCatalog(CORE_BLOCKS, ""))).toHaveLength(CORE_BLOCKS.length)
  })
})

describe("the role gate", () => {
  const entries = CORE_BLOCKS

  it("offers Advanced entries to admins only, with the Admins pill", () => {
    expect(names(menuEntries({ role: "admin" }, entries))).toContain("Custom HTML")
    expect(names(menuEntries({ role: "Admin" }, entries))).toContain("Custom HTML")
    // Contributors don't get the embeds (#425: resolving a link is for editors and up).
    const embeds = CORE_BLOCKS.filter((entry) => entry.group === "embeds").length
    const everyoneElse = CORE_BLOCKS.length - 1
    for (const [role, count] of [["editor", everyoneElse], ["contributor", everyoneElse - embeds], [null, everyoneElse - embeds], [undefined, everyoneElse - embeds]] as const) {
      expect(names(menuEntries({ role }, entries))).not.toContain("Custom HTML")
      expect(menuEntries({ role }, entries)).toHaveLength(count)
    }
    expect(isAdminOnly(customHtml)).toBe(true)
    expect(CORE_BLOCKS.filter(isAdminOnly)).toEqual([customHtml])
    // The Advanced group shows only when an admin's menu has something in it.
    expect(searchCatalog(menuEntries({ role: "admin" }, entries), "").map((s) => s.label)).toContain("Advanced")
    expect(searchCatalog(menuEntries({ role: "editor" }, entries), "").map((s) => s.label)).not.toContain("Advanced")
  })

  it("follows an entry's own roles", () => {
    const editorsUp: CatalogEntry = { ...customHtml, group: "layout", roles: ["admin", "editor"] }
    expect(canInsert(editorsUp, "editor")).toBe(true)
    expect(canInsert(editorsUp, "contributor")).toBe(false)
    expect(isAdminOnly(editorsUp)).toBe(false)
    expect(canInsert(CORE_BLOCKS[0], null)).toBe(true)
  })
})

// --- Every block, inserted and turned into, in a real (headless) editor ------------

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function makeEditor(content: string) {
  editor = new Editor({ element: document.createElement("div"), extensions: Object.values(schemaExtensions({ collaborating: false })), content })
  return editor
}

// The ProseMirror node each core entry makes (its Block Spec type in the editor).
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
  audio: "audio",
  file: "file",
  embed: "embed",
  html: "html",
  columns: "columns",
  buttons: "buttons",
  spacer: "spacer",
  footnotes: "footnotes",
  cover: "cover",
  media_text: "mediaText",
}

describe("insert", () => {
  it.each(CORE_BLOCKS.map((e) => [e.id, e] as const))("%s replaces the typed /query with the block", (_id, entry) => {
    const ed = makeEditor("<p>first</p><p>/que</p>")
    const from = ed.state.doc.firstChild!.nodeSize + 1
    ed.commands.setTextSelection(from + 4)
    entry.insert(ed, { from, to: from + 4 })
    // The table asks for its size first (#420), the columns for a layout (#426).
    currentTableSizePicker()?.submit()
    currentColumnsPicker()?.pick(0)
    const types: string[] = []
    ed.state.doc.forEach((node) => types.push(node.type.name))
    expect(types).toContain(PM_NODE[entry.type])
    expect(ed.state.doc.textContent).not.toContain("/que")
    expect(ed.state.doc.firstChild!.textContent).toBe("first")
    if (entry.type === "heading") {
      const heading = ed.state.doc.child(1)
      expect(heading.attrs.level).toBe(Number(entry.id.slice(-1)))
    }
  })
})

// #488 (design theme-builder.md 4.4): the Site group, offered by the kind of document.
describe("the Site group (#488)", () => {
  it("is offered in templates and parts, never in a post, and the template part only in a template", () => {
    expect(SITE_BLOCKS.map((e) => e.name)).toEqual([
      "Site title",
      "Site tagline",
      "Site logo",
      "Navigation",
      "Search",
      "Template part",
      // #489
      "Query loop",
      "Post template",
      "Pagination",
      "No results",
      "Query title",
      "Term description",
      "Post title",
      "Post content",
      "Post excerpt",
      "Featured image",
      "Post date",
      "Post byline",
      "Post terms",
      "Post navigation",
      // #497
      "Related posts",
      "Author cards",
      "Table of contents",
      "Colour scheme switch",
      // #498
      "Query total",
      "Author avatar",
      "Search results",
      "Post details",
      "Copyright",
      "GoLive credit",
      // #500
      "Comments",
    ])
    expect(SITE_BLOCKS.every((e) => e.group === "site")).toBe(true)
    expect(catalogEntries()).toEqual(expect.arrayContaining([...SITE_BLOCKS]))
    // A post (the default context) gets none of them, whatever the role.
    for (const role of ["admin", "editor", "contributor"]) {
      expect(menuEntries({ role }).filter((e) => e.group === "site")).toEqual([])
      expect(menuEntries({ role, context: "post" }).filter((e) => e.group === "site")).toEqual([])
    }
    expect(names(menuEntries({ role: "editor", context: "template" }).filter((e) => e.group === "site"))).toEqual(names(SITE_BLOCKS))
    expect(names(menuEntries({ role: "editor", context: "part" }).filter((e) => e.group === "site"))).not.toContain("Template part")
    // #489: a part never holds the post's body (design 4.2); it may hold a query loop.
    expect(names(menuEntries({ role: "editor", context: "part" }).filter((e) => e.group === "site"))).not.toContain("Post content")
    // #500: nor the post's comments (reader-comments 11.1).
    expect(names(menuEntries({ role: "editor", context: "part" }).filter((e) => e.group === "site"))).not.toContain("Comments")
    expect(names(menuEntries({ role: "editor", context: "part" }).filter((e) => e.group === "site"))).toContain("Query loop")
    // Every core block is still offered in a post; in templates and parts too, but Custom HTML
    // and footnotes (#493: their data is a post's, post_html_snippets and the post's notes).
    const postOnly = ["footnote", "html"]
    expect(CORE_BLOCKS.every((e) => offeredIn(e, "post"))).toBe(true)
    expect(CORE_BLOCKS.filter((e) => !offeredIn(e, "template") || !offeredIn(e, "part")).map((e) => e.id)).toEqual(postOnly)
    expect(menuEntries({ role: "admin", context: "template" }).map((e) => e.id)).not.toEqual(expect.arrayContaining(postOnly))
    expect(searchCatalog(menuEntries({ role: "admin", context: "template" }), "").map((s) => s.label)).toContain("Site")
    expect(searchCatalog(menuEntries({ role: "admin" }), "").map((s) => s.label)).not.toContain("Site")
  })

  // #493 (the template board's "Inserting"): the Site group comes first wherever it's offered.
  it("puts the Site group first in a template's menus", () => {
    expect(searchCatalog(menuEntries({ role: "admin", context: "template" }), "").map((s) => s.label)[0]).toBe("Site")
    expect(searchCatalog(menuEntries({ role: "admin" }), "").map((s) => s.label)[0]).toBe("Text")
  })

  // The query loop's parts are only offered inside a query (below).
  const topLevel = SITE_BLOCKS.filter((e) => holderAcceptsType("doc", e.type))
  it.each(topLevel.map((e) => [e.id, e] as const))("%s replaces the typed /query with its block, defaults filled in", (_id, entry) => {
    const ed = makeEditor("<p>first</p><p>/que</p>")
    const from = ed.state.doc.firstChild!.nodeSize + 1
    ed.commands.setTextSelection(from + 4)
    entry.insert(ed, { from, to: from + 4 })
    const node = ed.state.doc.child(1)
    expect(node.type.name).toBe(SITE_BLOCK_NODE_NAMES[entry.type as SiteBlockType])
    expect(node.attrs).toMatchObject(siteBlockNodeAttrs(entry.type as SiteBlockType, {}))
    // A query loop comes whole (#489): its "no results" says so until someone changes it.
    expect(ed.state.doc.textContent).toBe(entry.type === "query" ? `first${QUERY_NO_RESULTS_TEXT}` : "first")
  })

  it("#489: a query loop comes whole, and its post template, pager and no results are offered only inside a query", () => {
    expect(SITE_BLOCKS.filter((e) => !holderAcceptsType("doc", e.type)).map((e) => e.type)).toEqual(["post_template", "query_pagination", "query_no_results"])
    for (const holder of ["doc", "group", "column", "postTemplate", "queryNoResults"]) {
      const offered = menuEntries({ role: "editor", context: "template", accepts: (e) => holderAcceptsType(holder, e.type) }).map((e) => e.type)
      for (const type of ["post_template", "query_pagination", "query_no_results"]) expect(offered, `${holder} ${type}`).not.toContain(type)
      // Never a query in a post template or no results, nor in a column: the table stays acyclic.
      expect(offered.includes("query"), holder).toBe(holder === "doc" || holder === "group")
      expect(offered, holder).toContain("post_title")
    }
    const inQuery = menuEntries({ role: "editor", context: "template", accepts: (e) => holderAcceptsType("query", e.type) }).map((e) => e.type)
    expect(inQuery).toEqual(["post_template", "query_pagination", "query_no_results"])

    const ed = makeEditor("<p>/que</p>")
    SITE_BLOCKS.find((e) => e.type === "query")!.insert(ed, { from: 1, to: 5 })
    const query = ed.state.doc.firstChild!
    expect(query.type.name).toBe("query")
    expect(() => query.check()).not.toThrow()
    const kids: string[] = []
    query.forEach((child) => kids.push(child.type.name))
    expect(kids).toEqual(["postTemplate", "queryPagination", "queryNoResults"])
    const inTemplate: string[] = []
    query.firstChild!.forEach((child) => inTemplate.push(child.type.name))
    expect(inTemplate).toEqual(["postTitle", "postDate", "postExcerpt"])
  })
})

describe("turn into (turnInto.ts reads the catalog)", () => {
  it("offers the text blocks, in menu order", () => {
    expect(turnIntoEntries().map((e) => e.id)).toEqual([
      "paragraph",
      "heading-1",
      "heading-2",
      "heading-3",
      "heading-4",
      "heading-5",
      "heading-6",
      "bullet-list",
      "numbered-list",
      "todo-list",
      "quote",
      "pull-quote",
      "callout",
      "code-block",
    ])
  })

  it.each(turnIntoEntries().map((e) => [e.id] as const))("turns a paragraph into %s, and reads it back", (id) => {
    const ed = makeEditor("<p>hello</p>")
    ed.commands.setTextSelection(3)
    expect(applyTurnInto(ed, id)).toBe(true)
    expect(ed.state.doc.textContent).toBe("hello")
    expect(computeTurnIntoFromSelection(ed)).toBe(id)
  })

  it("turns a heading back into a paragraph and one list into the other, without unwrapping", () => {
    const ed = makeEditor("<h2>title</h2>")
    ed.commands.setTextSelection(2)
    expect(computeTurnIntoFromSelection(ed)).toBe("heading-2")
    applyTurnInto(ed, "paragraph")
    expect(ed.state.doc.firstChild!.type.name).toBe("paragraph")

    applyTurnInto(ed, "bullet-list")
    applyTurnInto(ed, "bullet-list") // again: stays a list
    expect(ed.state.doc.firstChild!.type.name).toBe("bulletList")
    applyTurnInto(ed, "numbered-list")
    expect(ed.state.doc.firstChild!.type.name).toBe("orderedList")
    expect(computeTurnIntoFromSelection(ed)).toBe("numbered-list")
  })

  it("turns a numbered list nested in a bulleted one into a bulleted list (the nearest list counts)", () => {
    const ed = makeEditor("<ul><li><p>outer</p><ol><li><p>inner</p></li></ol></li></ul>")
    let inner = 0
    ed.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "inner") inner = pos + 1
    })
    ed.commands.setTextSelection(inner)
    expect(computeTurnIntoFromSelection(ed)).toBe("numbered-list")
    applyTurnInto(ed, "bullet-list")
    const lists: string[] = []
    ed.state.doc.descendants((node) => {
      if (node.type.name.endsWith("List")) lists.push(node.type.name)
    })
    expect(lists).toEqual(["bulletList", "bulletList"])
  })

  it("refuses an entry without Turn into, or an unknown one", () => {
    const ed = makeEditor("<p>hello</p>")
    expect(applyTurnInto(ed, "divider")).toBe(false)
    expect(applyTurnInto(ed, "nope")).toBe(false)
    expect(ed.state.doc.firstChild!.type.name).toBe("paragraph")
  })
})
