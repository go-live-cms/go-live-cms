import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { paragraphDoc } from "../../../collab-server/testkit"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { acquireHocuspocus, releaseHocuspocus } from "@gl-admin/lib/collaboration/HocuspocusCollaboration"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import { restoreTemplateVersion } from "@gl-admin/lib/collaboration/templateRestore"
import { menuEntries, offeredOnce, searchCatalog } from "@gl-admin/components/editor/blocks/catalog"
import { editorDocKind, type SiteEditorBridge } from "@gl-admin/components/editor/extensions/SiteBlocks"
import { tiptapExtensionRegistry } from "@gl-admin/components/editor/utils/extensionRegistry"

// The Site editor's template and part editors (#493) are the post editor, bound to a
// template's own collab document (`template-<id>`, #490) on the real collab server in-process:
// the same bound editor and rules, the kind's site blocks offered first, the part card opening
// its part, presence between two admins, the server's store reaching the page (`onStored`, what
// the preview reloads on), restore through the editor (rule 9), and an editor refused.

stubJsdomRangeLayout()

const state = vi.hoisted(() => ({ relay: null as any, user: "4" }))

vi.mock("@gl-admin/lib/collaboration/postCollab", () => ({
  acquirePostCollab: (id: number, kind: "post" | "template" = "post") =>
    acquireHocuspocus(kind === "template" ? `template-${id}` : id, () => state.relay.client(state.user, { docKind: kind, postId: id })),
  releasePostCollab: (instance: any) => releaseHocuspocus(instance),
}))
vi.mock("@gl-admin/contexts/ThemeContext", () => ({ useTheme: () => ({ isThemeLoaded: true, themeSlug: "test" }) }))
vi.mock("@gl-admin/lib/api/blockAPI", () => ({ blockAPIClient: { setAuthToken: vi.fn(), getPostBlocks: vi.fn(), publishPost: vi.fn() } }))
vi.mock("@gl-admin/lib/auth", () => ({
  authManager: { getAccessToken: () => "token", subscribe: () => () => {}, getState: () => ({ user: { role: "admin" } }), logout: vi.fn(async () => {}) },
}))
vi.mock("@gl-admin/lib/api/siteDesign", () => ({
  getSiteTemplate: vi.fn(async () => ({ block_doc: { doc_version: 1, blocks_order: [], blocks: {} } })),
}))
vi.mock("@gl-admin/components/editor/ui/BubbleMenu", () => ({ default: () => null }))
vi.mock("@gl-admin/components/editor/ui/BlockTypeToolbar", () => ({ default: () => null }))
vi.mock("@gl-admin/components/editor/ui/DragHandle", () => ({ default: () => null }))
vi.mock("@gl-admin/components/editor/ui/MediaPickerHost", () => ({ default: () => null }))
vi.mock("@gl-admin/components/editor/ui/CharacterCount", () => ({ default: () => null }))
vi.mock("@gl-admin/components/editor/ui/LinkModal", () => ({ default: () => null }))

import Editor, { type EditorProps, type EditorRef } from "@gl-admin/components/editor/Editor"

const TEMPLATE_ID = 31

function templateDoc(...texts: string[]): BlockDocV1 {
  const doc = paragraphDoc(...texts)
  const header = "blk-part-header01"
  doc.blocks[header] = { id: header, type: "template_part", version: 1, attrs: { slug: "header" } } as unknown as BlockDocV1["blocks"][string]
  doc.blocks_order = [header, ...doc.blocks_order]
  return canonical(doc)
}

let relay: Relay
const roots: Array<{ root: Root; container: HTMLDivElement }> = []

const settle = async (ms = 0) => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((resolve) => setTimeout(resolve, ms)))
}
const until = async (check: () => boolean, what: string, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
  }
  await settle()
}

beforeEach(async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  relay = await startRelay()
  state.relay = relay
  state.user = "4"
  relay.api.addTemplate(String(TEMPLATE_ID), templateDoc("Working one"), "template", 3)
  relay.api.users.set("4", { role: "admin" })
  relay.api.users.set("5", { role: "admin" })
  relay.api.users.set("6", { role: "editor" })
  tiptapExtensionRegistry.clear()
})

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
  await relay.destroy()
  vi.restoreAllMocks()
})

async function mount(user: string, props: Partial<EditorProps> = {}) {
  state.user = user
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  const ref = createRef<EditorRef>()
  let editor: TiptapEditor | null = null
  await act(async () => {
    root.render(
      <Editor
        ref={ref}
        value=""
        onChange={() => {}}
        templateId={TEMPLATE_ID}
        templateKind="template"
        onEditorReady={(e) => {
          editor = e
        }}
        {...props}
      />
    )
  })
  return { ref, container, editor: () => editor }
}

const storedTexts = () => {
  const doc = relay.api.templates.get(String(TEMPLATE_ID))!.block_doc!
  return doc.blocks_order.map((id) => (doc.blocks[id].attrs as { text?: string }).text).filter(Boolean)
}

describe("the template editor (#493)", () => {
  it("binds the template's document with its kind, and offers the Site group first", async () => {
    const { container, editor } = await mount("4")
    await until(() => !!container.querySelector(".ProseMirror")?.textContent?.includes("Working one"), "the bound template")
    expect(container.querySelector(".ProseMirror")!.getAttribute("contenteditable")).toBe("true")
    expect(container.querySelector(".ProseMirror")!.getAttribute("aria-label")).toBe("Template content")
    expect(relay.server.hocuspocus.documents.has(`template-${TEMPLATE_ID}`)).toBe(true)
    expect(editorDocKind(editor())).toBe("template")
    expect(searchCatalog(menuEntries({ role: "admin", context: editorDocKind(editor()) }), "").map((s) => s.label)[0]).toBe("Site")
    // Post content once per template (design 4.2): not offered again once the doc has one.
    const offered = () => menuEntries({ role: "admin", context: "template" }).filter(offeredOnce(editor()!)).map((e) => e.type)
    expect(offered()).toContain("post_content")
    await act(async () => {
      editor()!.chain().focus("end").insertSiteBlock("post_content").run()
    })
    expect(offered()).not.toContain("post_content")
  })

  it("the part card says the part's state and opens it", async () => {
    const openPart = vi.fn()
    const bridge: SiteEditorBridge = { openPart, partStatus: (slug) => ({ detail: `Template part · ${slug} customized`, action: "Edit part" }) }
    const { container } = await mount("4", { siteBridge: bridge })
    await until(() => !!container.querySelector(".editor-site-block__open"), "the part card's button")
    const button = container.querySelector<HTMLButtonElement>(".editor-site-block__open")!
    expect(button.textContent).toBe("Edit part")
    expect(button.getAttribute("aria-label")).toBe("Edit part: Header")
    expect(container.querySelector(".editor-site-block--part")!.textContent).toContain("Template part · header customized")
    await act(async () => button.click())
    expect(openPart).toHaveBeenCalledWith("header")
  })

  it("two admins edit at once; the server stores, and the page hears it", async () => {
    const onStored = vi.fn()
    const a = await mount("4", { onStored })
    const b = await mount("5")
    await until(() => !!a.editor() && !!b.editor(), "both editors")
    await act(async () => {
      a.editor()!.chain().focus("end").insertContent("Alpha").run()
    })
    await until(() => !!b.container.querySelector(".ProseMirror")?.textContent?.includes("Alpha"), "the edit at the other admin")
    await until(() => storedTexts().some((text) => text?.includes("Alpha")), "the store", 8000)
    await until(() => onStored.mock.calls.length > 0, "the stored message")
  })

  it("restores a version through the editor (rule 9)", async () => {
    const { ref, editor } = await mount("4")
    await until(() => !!ref.current?.getRestoreTarget(), "an editable editor")
    const target = { ...ref.current!.getRestoreTarget()!, templateId: TEMPLATE_ID }
    const version = templateDoc("Restored")
    const api = {
      getSiteTemplateVersion: vi.fn(async () => ({ version_no: 2, reset: false, block_doc: version })),
      recordSiteTemplateRestore: vi.fn(async () => ({ id: TEMPLATE_ID }) as never),
      getSiteTemplateDefault: vi.fn(),
      recordSiteTemplateStartOver: vi.fn(),
      resetSiteTemplate: vi.fn(),
    }
    const result = await act(async () => restoreTemplateVersion(target, 2, { api, timeoutMs: 8000 }))
    expect(result.saved).toBe(true)
    expect(editor()!.getText()).toContain("Restored")
    expect(storedTexts()).toEqual(["Restored"])
    expect(api.recordSiteTemplateRestore).toHaveBeenCalledWith(TEMPLATE_ID, 2)
  })

  it("an editor is refused: the template closed, nothing bound", async () => {
    const { container, ref } = await mount("6")
    await until(() => container.textContent!.includes("This template closed"), "the refusal")
    expect(container.querySelector(".ProseMirror")).toBeNull()
    expect(ref.current?.getRestoreTarget() ?? null).toBeNull()
  })

  it("read-only while a reset waits for publish: no restore target", async () => {
    const { container, ref } = await mount("4", { readOnly: true })
    await until(() => !!container.querySelector(".ProseMirror")?.textContent?.includes("Working one"), "the bound template")
    expect(container.querySelector(".ProseMirror")!.getAttribute("contenteditable")).toBe("false")
    expect(ref.current!.getRestoreTarget()).toBeNull()
  })
})
