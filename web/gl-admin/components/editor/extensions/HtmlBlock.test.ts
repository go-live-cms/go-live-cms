import { describe, it, expect, afterEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { authManager } from "@gl-admin/lib/auth"
import { PostHtmlSnippetsStore } from "@gl-admin/lib/htmlSnippetsStore"
import { HTML_LOCKED_NOTE } from "@gl-admin/lib/blocks-spec"
import { BlockNodeViews } from "./BlockNodeViews"
import { provideHtmlSnippets, requestHtmlFieldFocus } from "../blocks/htmlSnippets"
import { CORE_BLOCKS, menuEntries } from "../blocks/catalog"
import { duplicateBlock } from "../utils/blockActions"

// The custom HTML block in the editor (#428; the canvas's "Editor · embeds, custom HTML"): an
// admin's code field and Preview, and the locked preview an editor or contributor gets, who
// can still move the block.

const BLOCK = "html-aaaa-0000000001"
const SNIPPET = "11111111-1111-4111-8111-111111111111"
const NEW_ID = "22222222-2222-4222-8222-222222222222"
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let editor: Editor | null = null

function api(rows: { id: string; html: string }[] = []) {
  return {
    listHtmlSnippets: vi.fn(async () => rows),
    createHtmlSnippet: vi.fn(async (_postId: number, html: string) => ({ id: NEW_ID, html })),
    updateHtmlSnippet: vi.fn(async (_postId: number, id: string, html: string) => ({ id, html })),
  }
}

function asRole(role: string) {
  vi.spyOn(authManager, "getState").mockReturnValue({ user: { role } } as never)
}

const html = (snippetId: string | null = SNIPPET) => ({ type: "html", attrs: { "data-block-id": BLOCK, snippetId } })
const paragraph = { type: "paragraph", content: [{ type: "text", text: "after" }] }
const docWith = (...nodes: object[]) => ({ type: "doc", content: nodes })

async function open(content: object, { role = "admin", rows = [{ id: SNIPPET, html: "<p>Office hours</p>" }], editable = true, store: withStore = true } = {}) {
  asRole(role)
  const element = document.createElement("div")
  document.body.appendChild(element)
  editor = new Editor({ element, editable, extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockNodeViews], content })
  const fake = api(rows)
  const store = new PostHtmlSnippetsStore(12, fake)
  if (withStore) provideHtmlSnippets(editor, store)
  await flush()
  await flush()
  return { api: fake, store }
}

afterEach(() => {
  const element = editor?.options.element as HTMLElement | undefined
  editor?.destroy()
  element?.remove()
  editor = null
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const dom = () => editor!.view.dom.querySelector<HTMLElement>("[data-type='html']")!
const field = () => dom().querySelector<HTMLTextAreaElement>("textarea")
const preview = () => dom().querySelector<HTMLElement>(".editor-html__preview")
const radio = (name: string) => [...dom().querySelectorAll<HTMLButtonElement>("[role='radio']")].find((b) => b.textContent === name)!

function type(text: string) {
  field()!.value = text
  field()!.dispatchEvent(new Event("input", { bubbles: true }))
}

describe("the schema", () => {
  it("is an atom holding a snippet id, stored as just that", async () => {
    await open(docWith(html(), paragraph))
    expect(editor!.schema.nodes.html.isAtom).toBe(true)
    expect(editor!.schema.nodes.html.spec.attrs).toHaveProperty("snippetId")
    expect(Object.keys(editor!.schema.nodes.html.spec.attrs!)).not.toContain("html")
    expect(pmToBlockDoc(editor!.state.doc).blocks[BLOCK]).toEqual({ id: BLOCK, type: "html", version: 1, attrs: { snippetId: SNIPPET } })
  })

  it("no HTML can make one: nothing parses to it, and the id is never rendered", async () => {
    await open(docWith(html(), paragraph))
    expect(editor!.getHTML()).not.toContain(SNIPPET)
    editor!.commands.setContent(`<div data-type="html" snippetid="${SNIPPET}"><script>alert(1)</script></div><p>x</p>`)
    const names: string[] = []
    editor!.state.doc.forEach((node) => names.push(node.type.name))
    expect(names).not.toContain("html")
  })

  it("is admins only in the menus, and empty when inserted", async () => {
    await open(docWith(paragraph))
    expect(menuEntries({ role: "editor" }).some((entry) => entry.id === "html")).toBe(false)
    expect(menuEntries({ role: "contributor" }).some((entry) => entry.id === "html")).toBe(false)
    expect(menuEntries({ role: "admin" }).some((entry) => entry.id === "html")).toBe(true)
    CORE_BLOCKS.find((entry) => entry.id === "html")!.insert(editor!, { from: 1, to: 1 })
    expect(editor!.state.doc.child(0).type.name).toBe("html")
    expect(editor!.state.doc.child(0).attrs.snippetId).toBeNull()
  })

  it("a duplicate starts empty: two blocks can't share a snippet", async () => {
    await open(docWith(html(), paragraph))
    duplicateBlock(editor!, { id: BLOCK, pos: 0 })
    expect(editor!.state.doc.child(0).attrs.snippetId).toBe(SNIPPET)
    expect(editor!.state.doc.child(1).type.name).toBe("html")
    expect(editor!.state.doc.child(1).attrs.snippetId).toBeNull()
  })
})

describe("as an admin", () => {
  it("shows the post's markup in the field, and Preview shows what the server has", async () => {
    await open(docWith(html(), paragraph))
    expect(field()!.value).toBe("<p>Office hours</p>")
    expect(radio("HTML").getAttribute("aria-checked")).toBe("true")
    radio("Preview").click()
    expect(field()).toBeNull()
    expect(preview()!.innerHTML).toBe("<p>Office hours</p>")
    expect(radio("Preview").getAttribute("aria-checked")).toBe("true")
  })

  it("saves through the API after a pause, as one update", async () => {
    const { api: fake } = await open(docWith(html(), paragraph))
    vi.useFakeTimers()
    type("<p>One</p>")
    type("<p>Two</p>")
    expect(fake.updateHtmlSnippet).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fake.updateHtmlSnippet).toHaveBeenCalledTimes(1)
    expect(fake.updateHtmlSnippet).toHaveBeenCalledWith(12, SNIPPET, "<p>Two</p>")
    vi.useRealTimers()
  })

  it("the first save makes the snippet and puts its id on the block", async () => {
    const { api: fake } = await open(docWith(html(null), paragraph))
    type("<p>New</p>")
    field()!.dispatchEvent(new FocusEvent("blur"))
    await flush()
    await flush()
    expect(fake.createHtmlSnippet).toHaveBeenCalledWith(12, "<p>New</p>")
    expect(editor!.state.doc.child(0).attrs.snippetId).toBe(NEW_ID)
  })

  it("an id that isn't this post's gets a new snippet, never a write to it", async () => {
    const { api: fake } = await open(docWith(html("33333333-3333-4333-8333-333333333333"), paragraph))
    expect(field()!.value).toBe("")
    type("<p>Mine</p>")
    field()!.dispatchEvent(new FocusEvent("blur"))
    await flush()
    await flush()
    expect(fake.updateHtmlSnippet).not.toHaveBeenCalled()
    expect(editor!.state.doc.child(0).attrs.snippetId).toBe(NEW_ID)
  })

  it("Publish waits for an edit still on its timer", async () => {
    const { api: fake, store } = await open(docWith(html(), paragraph))
    type("<p>Last words</p>")
    expect(fake.updateHtmlSnippet).not.toHaveBeenCalled()
    await store.flush()
    expect(fake.updateHtmlSnippet).toHaveBeenCalledWith(12, SNIPPET, "<p>Last words</p>")
  })

  it("the field is closed until the post's snippets are read", async () => {
    asRole("admin")
    const element = document.createElement("div")
    document.body.appendChild(element)
    editor = new Editor({ element, extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockNodeViews], content: docWith(html(), paragraph) })
    let answer: (rows: { id: string; html: string }[]) => void = () => {}
    const store = new PostHtmlSnippetsStore(12, { ...api(), listHtmlSnippets: () => new Promise((resolve) => (answer = resolve)) })
    provideHtmlSnippets(editor, store)
    expect(field()!.disabled).toBe(true)
    answer([{ id: SNIPPET, html: "<p>Stored</p>" }])
    await flush()
    await flush()
    expect(field()!.disabled).toBe(false)
    expect(field()!.value).toBe("<p>Stored</p>")
  })

  it("says so when a save fails, and keeps the text", async () => {
    const { api: fake } = await open(docWith(html(), paragraph))
    fake.updateHtmlSnippet.mockRejectedValueOnce(new Error("down"))
    type("<p>Kept</p>")
    field()!.dispatchEvent(new FocusEvent("blur"))
    await flush()
    await flush()
    expect(dom().querySelector("[role='alert']")!.textContent).toContain("Couldn't save")
    expect(field()!.value).toBe("<p>Kept</p>")
  })

  it("Tab indents, ⇧Tab outdents, and Esc then Tab leaves", async () => {
    await open(docWith(html(), paragraph))
    const area = field()!
    area.value = "abc"
    area.setSelectionRange(3, 3)

    const press = (key: string, shiftKey = false) => {
      const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })
      area.dispatchEvent(event)
      return event
    }

    expect(press("Tab").defaultPrevented).toBe(true)
    expect(area.value).toBe("abc  ")

    area.value = "  abc"
    area.setSelectionRange(5, 5)
    expect(press("Tab", true).defaultPrevented).toBe(true)
    expect(area.value).toBe("abc")

    press("Escape")
    expect(press("Tab").defaultPrevented).toBe(false)
  })

  it("focuses the field of a block the menu just made", async () => {
    await open(docWith(html(), paragraph))
    requestHtmlFieldFocus()
    editor!.commands.insertContentAt(editor!.state.doc.content.size, { type: "html" })
    await flush()
    await flush()
    const fields = editor!.view.dom.querySelectorAll("textarea")
    expect(document.activeElement).toBe(fields[fields.length - 1])
  })

  it("waits for the post's snippets before taking the cursor", async () => {
    asRole("admin")
    const element = document.createElement("div")
    document.body.appendChild(element)
    editor = new Editor({ element, extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockNodeViews], content: docWith(paragraph) })
    let answer: (rows: { id: string; html: string }[]) => void = () => {}
    const store = new PostHtmlSnippetsStore(12, { ...api(), listHtmlSnippets: () => new Promise((resolve) => (answer = resolve)) })
    provideHtmlSnippets(editor, store)
    requestHtmlFieldFocus()
    editor.commands.insertContentAt(0, { type: "html" })
    await flush()
    expect(document.activeElement).not.toBe(field())
    answer([])
    await flush()
    await flush()
    expect(document.activeElement).toBe(field())
  })

  it("a new post's block asks to be saved first", async () => {
    await open(docWith(html(null), paragraph), { store: false })
    expect(field()).toBeNull()
    expect(dom().textContent).toContain("Save the post")
  })
})

describe.each(["editor", "contributor"])("as a %s: the locked preview", (role) => {
  it("shows the markup with its note, and no field or switch", async () => {
    await open(docWith(html(), paragraph), { role })
    expect(dom().dataset.mode).toBe("locked")
    expect(field()).toBeNull()
    expect(dom().querySelector("[role='radiogroup']")).toBeNull()
    expect(dom().textContent).toContain(HTML_LOCKED_NOTE)
    expect(dom().textContent).toContain("Custom HTML")
    expect(preview()!.innerHTML).toBe("<p>Office hours</p>")
  })

  it("they can still select it, which is what moving and deleting start from", async () => {
    await open(docWith(html(), paragraph), { role })
    editor!.view.dispatch(editor!.state.tr.setSelection(NodeSelection.create(editor!.state.doc, 0)))
    expect((editor!.state.selection as NodeSelection).node.type.name).toBe("html")
    expect(dom().classList.contains("ProseMirror-selectednode")).toBe(true)
  })

  it("a snippet of another post shows nothing of it", async () => {
    await open(docWith(html("33333333-3333-4333-8333-333333333333"), paragraph), { role })
    expect(preview()!.textContent).toBe("No HTML yet.")
  })
})

describe("the preview", () => {
  it("cleans the markup again, whatever the API answered", async () => {
    await open(docWith(html(), paragraph), { role: "editor", rows: [{ id: SNIPPET, html: '<img src="x" onerror="alert(1)"><script>alert(2)</script><b>ok</b>' }] })
    expect(preview()!.innerHTML).not.toContain("onerror")
    expect(preview()!.innerHTML).not.toContain("script")
    expect(preview()!.innerHTML).toContain("<b>ok</b>")
  })

  it("a link in it doesn't navigate", async () => {
    await open(docWith(html(), paragraph), { role: "editor", rows: [{ id: SNIPPET, html: '<a href="https://example.com/x">x</a>' }] })
    const event = new MouseEvent("click", { bubbles: true, cancelable: true })
    preview()!.querySelector("a")!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it("a read-only admin gets it too, without the field", async () => {
    await open(docWith(html(), paragraph), { editable: false })
    expect(field()).toBeNull()
    expect(preview()!.innerHTML).toBe("<p>Office hours</p>")
  })
})
