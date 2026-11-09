import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { validateBlockDoc } from "@gl-admin/lib/blocks-spec"
import { ApiError } from "@gl-admin/lib/api/errors"
import { resetEditorSettings, setEditorSettings } from "@gl-admin/lib/editorSettings"
import { BlockNodeViews } from "./BlockNodeViews"
import { findSelectedEmbed } from "./EmbedBlock"
import { CORE_BLOCKS, embedEntryId, menuEntries } from "../blocks/catalog"
import { embedProviderOfHost, notAllowedError, openEmbedLinkField, pastedEmbedUrl, wrongProviderError } from "../blocks/embedLinks"

// The embed block in the editor (#425; the canvas's "Editor · embeds, custom HTML" and "Errors
// & empty states"): the empty block's link field, a link that isn't allowed, the placeholder
// that loads nothing until Load, Edit link, and a provider taken off the allowed list.

const api = vi.hoisted(() => ({ resolveEmbed: vi.fn() }))
vi.mock("@gl-admin/lib/api/embeds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gl-admin/lib/api/embeds")>()),
  resolveEmbed: api.resolveEmbed,
}))

let editor: Editor | null = null

const YT = "embed-aaaa-0000000001"
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  api.resolveEmbed.mockReset()
  setEditorSettings({ editor_markdown_shortcuts: true, editor_allowed_embeds: ["youtube", "vimeo", "x"] })
})
afterEach(() => {
  const element = editor?.options.element as HTMLElement | undefined
  editor?.destroy()
  element?.remove()
  editor = null
  resetEditorSettings()
  vi.restoreAllMocks()
})

function makeEditor(content: object, { editable = true } = {}): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  editor = new Editor({ element, editable, extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockNodeViews], content })
  return editor
}

const docWith = (...nodes: object[]) => ({ type: "doc", content: nodes })
const embed = (attrs: Record<string, unknown>, content?: object[]) => ({ type: "embed", attrs: { "data-block-id": YT, ...attrs }, ...(content ? { content } : {}) })
const paragraph = { type: "paragraph", content: [{ type: "text", text: "after" }] }
const filled = embed({ provider: "youtube", ref: "dQw4w9WgXcQ", title: "Two editors" })

const dom = () => editor!.view.dom.querySelector<HTMLElement>("figure[data-type='embed']")!
const input = () => dom().querySelector<HTMLInputElement>("input[type='url']")!
const buttonNamed = (name: string) => [...dom().querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement | undefined
const attrs = () => editor!.state.doc.child(0).attrs

async function submit(url: string) {
  input().value = url
  input().dispatchEvent(new Event("input", { bubbles: true }))
  buttonNamed("Embed")!.click()
  await flush()
  await flush()
}

describe("the schema", () => {
  it("has the attrs and an optional caption; none of it can come from a page", () => {
    makeEditor(docWith(embed({ provider: "x" }), paragraph))
    expect(editor!.schema.nodes.embed.spec.content).toBe("imageCaption?")
    editor!.commands.setContent('<figure data-type="embed" data-provider="youtube" data-ref="nope" data-title="<b>x</b>"><figcaption>c</figcaption></figure>')
    expect(editor!.state.doc.child(0).attrs).toMatchObject({ provider: "youtube", ref: null, title: null })
    editor!.commands.setContent('<figure data-type="embed" data-provider="evil" data-ref="dQw4w9WgXcQ"></figure>')
    expect(editor!.state.doc.child(0).attrs).toMatchObject({ provider: null, ref: null })
  })

  it("reads its own markup back, caption included", () => {
    makeEditor(docWith(embed({ provider: "youtube", ref: "dQw4w9WgXcQ", title: "T" }, [{ type: "imageCaption", content: [{ type: "text", text: "Cap" }] }]), paragraph))
    const html = editor!.getHTML()
    editor!.commands.setContent(html)
    expect(editor!.state.doc.child(0).attrs).toMatchObject({ provider: "youtube", ref: "dQw4w9WgXcQ", title: "T" })
    expect(editor!.state.doc.child(0).textContent).toBe("Cap")
  })

  it("is one of the editor's blocks, with an id, and stores validly", () => {
    makeEditor(docWith(filled, paragraph))
    const doc = pmToBlockDoc(editor!.state.doc)
    expect(doc.blocks[YT]).toEqual({ id: YT, type: "embed", version: 1, attrs: { provider: "youtube", ref: "dQw4w9WgXcQ", title: "Two editors" } })
    expect(() => validateBlockDoc(doc)).not.toThrow()
  })
})

describe("the menus", () => {
  const entries = CORE_BLOCKS.filter((entry) => entry.group === "embeds")

  it("offers YouTube, Vimeo, X and Embed a link, in the Embeds group", () => {
    expect(entries.map((entry) => entry.name)).toEqual(["YouTube", "Vimeo", "X", "Embed a link"])
    expect(entries.every((entry) => entry.type === "embed")).toBe(true)
  })

  it("offers them to editors and admins, who can resolve a link", () => {
    for (const role of ["admin", "editor"]) expect(menuEntries({ role }, entries)).toHaveLength(4)
    for (const role of ["contributor", null]) expect(menuEntries({ role }, entries)).toHaveLength(0)
  })

  it.each([
    ["embed-youtube", "youtube", "Paste a YouTube link"],
    ["embed-vimeo", "vimeo", "Paste a Vimeo link"],
    ["embed-x", "x", "Paste a link to a post on X"],
    ["embed-link", null, "Paste a link"],
  ])("%s inserts an empty block for that site and takes the focus", async (id, provider, prompt) => {
    makeEditor(docWith({ type: "paragraph", content: [{ type: "text", text: "/que" }] }))
    CORE_BLOCKS.find((entry) => entry.id === id)!.insert(editor!, { from: 1, to: 5 })
    expect(attrs()).toMatchObject({ provider, ref: null })
    expect(input().placeholder).toBe(prompt)
    await flush()
    expect(document.activeElement).toBe(input())
  })

  it("names the entry a stored provider belongs to", () => {
    expect(embedEntryId("vimeo")).toBe("embed-vimeo")
    expect(embedEntryId("codepen")).toBe("embed-link")
    expect(embedEntryId(null)).toBe("embed-link")
  })
})

describe("the link field", () => {
  it("resolves the pasted link and fills the block in one step", async () => {
    api.resolveEmbed.mockResolvedValue({ provider: "youtube", ref: "dQw4w9WgXcQ", title: "From the provider" })
    makeEditor(docWith(embed({ provider: "youtube" }), paragraph))
    await submit("youtu.be/dQw4w9WgXcQ")
    expect(api.resolveEmbed).toHaveBeenCalledWith("https://youtu.be/dQw4w9WgXcQ")
    expect(attrs()).toMatchObject({ provider: "youtube", ref: "dQw4w9WgXcQ", title: "From the provider" })
    expect(input()).toBeNull()
    expect(dom().textContent).toContain("From the provider")
  })

  it("accepts Enter", async () => {
    api.resolveEmbed.mockResolvedValue({ provider: "vimeo", ref: "76979871", title: "" })
    makeEditor(docWith(embed({ provider: null }), paragraph))
    input().value = "https://vimeo.com/76979871"
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await flush()
    await flush()
    expect(attrs()).toMatchObject({ provider: "vimeo", ref: "76979871", title: null })
  })

  it("says 'An embed link that isn't allowed' and which sites are, with the fix next to it", async () => {
    api.resolveEmbed.mockRejectedValue(new ApiError("nope", 400, null, "embed_not_allowed"))
    makeEditor(docWith(embed({ provider: null }), paragraph))
    await submit("https://www.tiktok.com/@a/video/1")
    const error = dom().querySelector(".editor-embed__error")!
    expect(error.textContent).toBe("An embed link that isn't allowed Embeds from tiktok.com aren't allowed on this site. Paste a link from YouTube, Vimeo or X.")
    expect(error.getAttribute("role")).toBe("alert")
    expect(input().getAttribute("aria-invalid")).toBe("true")
    expect(input().getAttribute("aria-describedby")).toBe(error.id)
    expect(buttonNamed("Remove block")).toBeDefined()
    expect(attrs()).toMatchObject({ ref: null })
    expect(document.activeElement).toBe(input())
  })

  it("says the right site with the wrong kind of link, in the block's own words", async () => {
    api.resolveEmbed.mockRejectedValue(new ApiError("nope", 400, null, "embed_not_allowed"))
    makeEditor(docWith(embed({ provider: "youtube" }), paragraph))
    await submit("https://www.youtube.com/feed/subscriptions")
    expect(dom().querySelector(".editor-embed__error")!.textContent).toContain("doesn't point to something YouTube can embed")
  })

  it("refuses another site's link in a block made for one, and writes nothing", async () => {
    api.resolveEmbed.mockResolvedValue({ provider: "vimeo", ref: "76979871", title: "T" })
    makeEditor(docWith(embed({ provider: "youtube" }), paragraph))
    await submit("https://vimeo.com/76979871")
    expect(dom().querySelector(".editor-embed__error")!.textContent).toBe("That's a Vimeo link. Paste a YouTube link here, or use the Vimeo block.")
    expect(attrs()).toMatchObject({ provider: "youtube", ref: null, title: null })
  })

  it("explains a contributor's 403, and any other failure, without writing", async () => {
    makeEditor(docWith(embed({ provider: "youtube" }), paragraph))
    api.resolveEmbed.mockRejectedValue(new ApiError("Forbidden", 403))
    await submit("https://youtu.be/dQw4w9WgXcQ")
    expect(dom().querySelector(".editor-embed__error")!.textContent).toBe("Only editors and admins can add an embed link.")
    expect(attrs().ref).toBeNull()
  })

  it("refuses what can't be a link before asking anyone", async () => {
    makeEditor(docWith(embed({ provider: null }), paragraph))
    await submit("javascript:alert(1)")
    expect(api.resolveEmbed).not.toHaveBeenCalled()
    expect(dom().querySelector(".editor-embed__error")!.textContent).toContain("doesn't look like a link")
  })

  it("Remove block takes the block away", async () => {
    api.resolveEmbed.mockRejectedValue(new ApiError("nope", 400, null, "embed_not_allowed"))
    makeEditor(docWith(embed({ provider: null }), paragraph))
    await submit("https://www.tiktok.com/x")
    buttonNamed("Remove block")!.click()
    expect(editor!.state.doc.child(0).type.name).toBe("paragraph")
  })

  it("applies to the block by its id, wherever it moved meanwhile", async () => {
    let answer!: (value: unknown) => void
    api.resolveEmbed.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    makeEditor(docWith(embed({ provider: "youtube" }), paragraph))
    input().value = "https://youtu.be/dQw4w9WgXcQ"
    buttonNamed("Embed")!.click()
    await flush()
    editor!.commands.insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: "pushed down" }] })
    answer({ provider: "youtube", ref: "dQw4w9WgXcQ", title: "Late" })
    await flush()
    await flush()
    expect(editor!.state.doc.child(1).attrs).toMatchObject({ ref: "dQw4w9WgXcQ", title: "Late" })
  })
})

describe("the placeholder", () => {
  it("shows provider, title, Load video and where it connects, and frames nothing", () => {
    makeEditor(docWith(filled, paragraph))
    expect(dom().dataset.state).toBe("placeholder")
    const text = dom().textContent!
    expect(text).toContain("YouTube video")
    expect(text).toContain("Two editors")
    expect(text).toContain("Loading connects to youtube.com")
    expect(buttonNamed("Load video")!.getAttribute("aria-label")).toBe("Load video: Two editors")
    expect(dom().querySelector("iframe")).toBeNull()
    expect(dom().querySelector("img")).toBeNull()
    expect(dom().innerHTML).not.toContain("youtube-nocookie")
  })

  it("loads the player only on Load, and only in this editor's view", () => {
    makeEditor(docWith(filled, paragraph))
    const before = JSON.stringify(editor!.state.doc.toJSON())
    buttonNamed("Load video")!.click()
    const iframe = dom().querySelector("iframe")!
    expect(iframe.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")
    expect(iframe.getAttribute("sandbox")).toContain("allow-scripts")
    expect(iframe.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin")
    expect(iframe.getAttribute("loading")).toBe("lazy")
    expect(iframe.title).toBe("YouTube player: Two editors")
    expect(document.activeElement).toBe(iframe)
    expect(JSON.stringify(editor!.state.doc.toJSON())).toBe(before)
  })

  it("shows X as a card, and frames its post without the widget's script", () => {
    makeEditor(docWith(embed({ provider: "x", ref: "20", title: "Post by jack" }), paragraph))
    expect(dom().querySelector(".editor-embed__facade.is-card")).not.toBeNull()
    buttonNamed("Load post")!.click()
    expect(dom().querySelector("iframe")!.getAttribute("src")).toContain("https://platform.twitter.com/embed/Tweet.html?id=20")
    expect(document.querySelector("script[src*='widgets.js']")).toBeNull()
  })

  it("closes the player when the link changes under it", () => {
    makeEditor(docWith(filled, paragraph))
    buttonNamed("Load video")!.click()
    editor!.view.dispatch(editor!.state.tr.setNodeMarkup(0, undefined, { ...attrs(), ref: "aaaaaaaaaaa" }))
    expect(dom().querySelector("iframe")).toBeNull()
    expect(buttonNamed("Load video")).toBeDefined()
  })

  it("says a provider was taken off the list, and doesn't offer Load", () => {
    setEditorSettings({ editor_markdown_shortcuts: true, editor_allowed_embeds: ["vimeo"] })
    makeEditor(docWith(filled, paragraph))
    expect(dom().dataset.state).toBe("blocked")
    expect(dom().textContent).toContain("This site is no longer allowed, so readers don't see this embed.")
    expect(buttonNamed("Load video")).toBeUndefined()
  })

  it("doesn't claim that before the setting has been read", () => {
    resetEditorSettings()
    makeEditor(docWith(filled, paragraph))
    expect(dom().dataset.state).toBe("placeholder")
  })

  it("names an untitled block after its provider", () => {
    makeEditor(docWith(embed({ provider: "vimeo", ref: "76979871" }), paragraph))
    expect(dom().querySelector(".editor-embed__title")!.textContent).toBe("Vimeo video")
  })

  it("is read-only for someone who can't edit: Load yes, no field", () => {
    makeEditor(docWith(filled, embed({ "data-block-id": "embed-aaaa-0000000002", provider: "x" })), { editable: false })
    expect(buttonNamed("Load video")).toBeDefined()
    expect(editor!.view.dom.querySelector("input")).toBeNull()
    expect(editor!.view.dom.querySelectorAll("figure")[1].textContent).toContain("No link yet.")
  })
})

describe("Edit link", () => {
  it("reopens the field on the item's own address, and Esc goes back", () => {
    makeEditor(docWith(filled, paragraph))
    openEmbedLinkField(editor!, 0)
    expect(input().value).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    expect(document.activeElement).toBe(input())
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(input()).toBeNull()
    expect(attrs().ref).toBe("dQw4w9WgXcQ")
  })

  it("may move the block to any allowed site", async () => {
    api.resolveEmbed.mockResolvedValue({ provider: "vimeo", ref: "76979871", title: "New" })
    makeEditor(docWith(filled, paragraph))
    openEmbedLinkField(editor!, 0)
    await submit("https://vimeo.com/76979871")
    expect(attrs()).toMatchObject({ provider: "vimeo", ref: "76979871", title: "New" })
  })

  it("Cancel leaves it as it was", () => {
    makeEditor(docWith(filled, paragraph))
    openEmbedLinkField(editor!, 0)
    buttonNamed("Cancel")!.click()
    expect(dom().dataset.state).toBe("placeholder")
  })
})

describe("the caption", () => {
  it("is added and removed like a media block's", () => {
    makeEditor(docWith(filled, paragraph))
    editor!.view.dispatch(editor!.state.tr.setSelection(NodeSelection.create(editor!.state.doc, 0)))
    expect(findSelectedEmbed(editor!.state)?.pos).toBe(0)
    expect(editor!.commands.toggleEmbedCaption()).toBe(true)
    expect(editor!.state.doc.child(0).childCount).toBe(1)
    editor!.commands.insertContent("A caption")
    expect(pmToBlockDoc(editor!.state.doc).blocks[YT].attrs).toMatchObject({ caption: [{ type: "text", text: "A caption" }] })
    expect(findSelectedEmbed(editor!.state)?.pos).toBe(0)
    editor!.commands.toggleEmbedCaption()
    expect(editor!.state.doc.child(0).childCount).toBe(0)
  })

  it("isn't offered until the block has a link", () => {
    makeEditor(docWith(embed({ provider: "x" }), paragraph))
    expect(dom().querySelector<HTMLButtonElement>(".editor-image__add-caption")!.hidden).toBe(true)
  })
})

describe("the words", () => {
  it("reads a bare address as https", () => {
    expect(pastedEmbedUrl("youtu.be/abc")?.href).toBe("https://youtu.be/abc")
    expect(pastedEmbedUrl("http://youtu.be/abc")?.href).toBe("http://youtu.be/abc")
    expect(pastedEmbedUrl("ftp://youtu.be/abc")).toBeNull()
    expect(pastedEmbedUrl("   ")).toBeNull()
  })

  it("knows a provider by its hosts", () => {
    expect(embedProviderOfHost("www.youtube.com")).toBe("youtube")
    expect(embedProviderOfHost("youtu.be")).toBe("youtube")
    expect(embedProviderOfHost("twitter.com")).toBe("x")
    expect(embedProviderOfHost("notyoutube.com")).toBeNull()
    expect(embedProviderOfHost("youtube.com.evil.example")).toBeNull()
  })

  it("points at Settings when nothing is allowed", () => {
    setEditorSettings({ editor_markdown_shortcuts: true, editor_allowed_embeds: [] })
    expect(notAllowedError(new URL("https://www.tiktok.com/x")).message).toContain("An admin can choose the sites in Settings › Editor.")
  })

  it("says a site that's merely off the list is off the list", () => {
    setEditorSettings({ editor_markdown_shortcuts: true, editor_allowed_embeds: ["vimeo"] })
    expect(notAllowedError(new URL("https://www.youtube.com/watch?v=x")).message).toBe("Embeds from youtube.com aren't allowed on this site. Paste a link from Vimeo.")
  })

  it("sends a provider with no block of its own to Embed a link", () => {
    expect(wrongProviderError("codepen", "youtube").message).toBe("That's a CodePen link. Paste a YouTube link here, or use Embed a link.")
  })
})
