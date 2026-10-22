import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"
import { Node, getSchema } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap"
import { BlockIdExtension } from "./extensions/BlockIdExtension"
import { tiptapExtensionRegistry } from "./utils/extensionRegistry"
import { EDITOR_FRAGMENT } from "@gl-admin/lib/collaboration/schemaGuard"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import Editor, { type EditorRef } from "./Editor"

// The schema gate in Editor.tsx (#206/#274): the real Editor, mounted on a shared doc
// holding a theme block. Without the theme extension it must open read-only and leave
// the doc alone; with it, it binds and keeps the block. (y-tiptap's deletion itself is
// pinned in lib/collaboration/schemaGuard.test.ts.)

/** The fake provider: a real Y.Doc + awareness, and a sync event the test fires. */
const fake = vi.hoisted(() => ({ collab: null as any, acquired: 0, released: 0 }))

vi.mock("@gl-admin/lib/collaboration/CollaborationProvider", () => ({
  CollaborationProvider: {
    getInstance: () => {
      fake.acquired++
      return fake.collab
    },
    release: () => {
      fake.released++
    },
  },
}))
vi.mock("@gl-admin/contexts/ThemeContext", () => ({
  useTheme: () => ({ isThemeLoaded: true, themeSlug: "test" }),
}))
vi.mock("@gl-admin/lib/api/blockAPI", () => ({
  blockAPIClient: {
    setAuthToken: vi.fn(),
    getPostBlocks: vi.fn(),
    updatePostBlocks: vi.fn(() => new Promise(() => {})),
    publishPost: vi.fn(),
  },
}))
vi.mock("@gl-admin/lib/auth", () => ({
  authManager: {
    getAccessToken: () => "token",
    subscribe: () => () => {},
    getState: () => ({ user: null }),
  },
}))
vi.mock("@gl-admin/lib/test/blockSpecTest", () => ({ createTestScript: () => {} }))
// UI chrome around the editor, not under test.
vi.mock("./ui/BubbleMenu", () => ({ default: () => null }))
vi.mock("./ui/BlockTypeToolbar", () => ({ default: () => null }))
vi.mock("./ui/DragHandle", () => ({ default: () => null }))
vi.mock("./ui/MediaSelector", () => ({ default: () => null }))
vi.mock("./ui/CharacterCount", () => ({ default: () => null }))
vi.mock("./ui/LinkModal", () => ({ default: () => null }))

import { blockAPIClient } from "@gl-admin/lib/api/blockAPI"

const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "inline*",
  addAttributes() {
    return { "data-block-id": { default: null }, variant: { default: "info" } }
  },
  parseHTML: () => [{ tag: "div[data-type=callout]" }],
  renderHTML: () => ["div", { "data-type": "callout" }, 0],
})

const live = {
  type: "doc",
  content: [
    { type: "paragraph", attrs: { "data-block-id": "intro-block-0001" }, content: [{ type: "text", text: "Intro" }] },
    { type: "callout", attrs: { "data-block-id": "callout-block-01" }, content: [{ type: "text", text: "Careful" }] },
  ],
}

// The REST working copy the read-only view loads (the callout is a custom block there).
const working: BlockDocV1 = {
  doc_version: 1,
  blocks_order: ["intro-block-0001"],
  blocks: { "intro-block-0001": { id: "intro-block-0001", type: "paragraph", version: 1, attrs: { text: "Intro" } } },
}

function makeCollab() {
  const doc = new Y.Doc()
  const handlers = new Map<string, Set<(...args: any[]) => void>>()
  const provider = {
    synced: false,
    awareness: new Awareness(doc),
    on: (event: string, fn: (...args: any[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(fn)
    },
    off: (event: string, fn: (...args: any[]) => void) => handlers.get(event)?.delete(fn),
    /** What y-websocket does once the server's state has been applied. */
    sync(state: object) {
      prosemirrorJSONToYXmlFragment(
        getSchema([StarterKit, BlockIdExtension, Callout]),
        state,
        doc.getXmlFragment(EDITOR_FRAGMENT)
      )
      this.synced = true
      for (const fn of [...(handlers.get("sync") ?? [])]) fn(true)
    },
  }
  return { doc, provider, whenSynced: Promise.resolve() }
}

const nodeTypes = () =>
  fake.collab.doc
    .getXmlFragment(EDITOR_FRAGMENT)
    .toArray()
    .map((el: Y.XmlElement) => el.nodeName)

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  fake.collab = makeCollab()
  fake.acquired = 0
  fake.released = 0
  tiptapExtensionRegistry.clear()
  vi.mocked(blockAPIClient.getPostBlocks).mockResolvedValue({ doc: working, revision: 1 } as any)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  tiptapExtensionRegistry.clear()
})

async function mount() {
  const ref = createRef<EditorRef>()
  await act(async () => {
    root.render(<Editor ref={ref} value="" onChange={() => {}} postId={7} />)
  })
  return ref
}

describe("Editor schema gate", () => {
  it("waits for the WS sync before mounting an editor", async () => {
    await mount()
    expect(container.querySelector(".ProseMirror")).toBeNull()
    expect(container.textContent).toContain("Connecting")
  })

  it("opens read-only and keeps the doc intact when the theme block's extension is missing", async () => {
    const ref = await mount()
    await act(async () => fake.collab.provider.sync(live))
    await settle()

    expect(nodeTypes()).toEqual(["paragraph", "callout"])
    const notice = container.querySelector(".editor-blocked-notice")
    expect(notice?.getAttribute("role")).toBe("alert")
    expect(notice?.textContent).toContain("callout (block)")
    const pm = container.querySelector(".ProseMirror")
    expect(pm?.getAttribute("contenteditable")).toBe("false")
    // The read-only view shows the REST working copy.
    expect(blockAPIClient.getPostBlocks).toHaveBeenCalledWith(7)
    expect(pm?.textContent).toContain("Intro")
    // Saving and publishing fail loudly instead of pretending to succeed.
    await expect(ref.current!.forceSave()).rejects.toThrow(/callout/)
    await expect(ref.current!.publish()).rejects.toThrow(/callout/)
    expect(blockAPIClient.updatePostBlocks).not.toHaveBeenCalled()
  })

  it("binds collaboration and keeps the block when the theme extension is registered", async () => {
    tiptapExtensionRegistry.register(Callout)
    await mount()
    await act(async () => fake.collab.provider.sync(live))
    await settle()

    expect(container.querySelector(".editor-blocked-notice")).toBeNull()
    const pm = container.querySelector(".ProseMirror")
    expect(pm?.getAttribute("contenteditable")).toBe("true")
    expect(pm?.textContent).toContain("Careful")
    // (StarterKit's TrailingNode may append an empty paragraph after the callout.)
    expect(nodeTypes().slice(0, 2)).toEqual(["paragraph", "callout"])
  })

  it("releases the provider references it took on unmount", async () => {
    await mount()
    await act(async () => fake.collab.provider.sync(live))
    await settle()
    await act(async () => root.unmount())
    root = createRoot(container)

    expect(fake.released).toBe(fake.acquired)
  })
})
