import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, createRef, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { Node } from "@tiptap/core"
import type * as Y from "yjs"
import { paragraphs } from "../../../collab-server/testkit"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { EDITOR_FRAGMENT } from "@gl-admin/lib/collaboration/schemaGuard"
import { RECHECK_MS, startRelay, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { acquireHocuspocus, releaseHocuspocus } from "@gl-admin/lib/collaboration/HocuspocusCollaboration"
import { tiptapExtensionRegistry } from "./utils/extensionRegistry"

// The editor (#206 P3, #283), mounted for real against the in-process collab
// server: the theme gate, the schema gate (rule 10: theme extensions must be registered
// before Collaboration binds), no client seeding, the live read-only view, a stale-epoch
// remount, publish without a client save, restore through the editor, and access changes
// while open (#313).

// jsdom has no layout: Range lacks getClientRects/getBoundingClientRect, which
// ProseMirror's scrollIntoView calls when the editor focuses itself after mounting.
// (On a timing-dependent tick that otherwise surfaces as an uncaught TypeError.)
const emptyRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) })
Range.prototype.getClientRects ??= function () {
  return Object.assign([], { item: () => null }) as unknown as DOMRectList
}
Range.prototype.getBoundingClientRect ??= emptyRect as unknown as () => DOMRect

const state = vi.hoisted(() => ({ relay: null as any, user: "1", themeLoaded: true }))

vi.mock("@gl-admin/lib/collaboration/postCollab", () => ({
  acquirePostCollab: (postId: number) => acquireHocuspocus(postId, () => state.relay.client(state.user)),
  releasePostCollab: (instance: any) => releaseHocuspocus(instance),
}))
vi.mock("@gl-admin/contexts/ThemeContext", () => ({
  useTheme: () => ({ isThemeLoaded: state.themeLoaded, themeSlug: "test" }),
}))
vi.mock("@gl-admin/lib/api/blockAPI", () => ({
  blockAPIClient: {
    setAuthToken: vi.fn(),
    getPostBlocks: vi.fn(),
    publishPost: vi.fn(),
  },
}))
vi.mock("@gl-admin/lib/auth", () => ({
  authManager: {
    getAccessToken: () => "token",
    subscribe: () => () => {},
    getState: () => ({ user: null }),
    logout: vi.fn(async () => {}),
  },
}))
vi.mock("./ui/BubbleMenu", () => ({ default: () => null }))
vi.mock("./ui/BlockTypeToolbar", () => ({ default: () => null }))
// Like the real one: TipTap's drag-handle plugin moves the component's element into the
// editor's DOM, so React can't unmount it on its own (removeChild throws). An access
// change must remount the whole editor instead (#313).
vi.mock("./ui/DragHandle", async () => {
  const { createElement, useLayoutEffect, useRef } = await import("react")
  return {
    default: function DragHandle({ editor }: { editor: { view: { dom: HTMLElement } } }) {
      const el = useRef<HTMLDivElement>(null)
      useLayoutEffect(() => {
        const host = editor.view.dom.parentElement
        if (el.current && host) host.appendChild(el.current)
      }, [editor])
      return createElement("div", { ref: el, className: "drag-handle-mock" })
    },
  }
})
vi.mock("./ui/MediaSelector", () => ({ default: () => null }))
vi.mock("./ui/CharacterCount", () => ({ default: () => null }))
vi.mock("./ui/LinkModal", () => ({ default: () => null }))

import { blockAPIClient } from "@gl-admin/lib/api/blockAPI"
import { authManager } from "@gl-admin/lib/auth"
import Editor, { type EditorProps, type EditorRef } from "./Editor"

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

const POST = 12
const doc: BlockDocV1 = {
  doc_version: 1,
  blocks_order: ["intro-block-0001", "callout-block-01"],
  blocks: {
    "intro-block-0001": { id: "intro-block-0001", type: "paragraph", version: 1, attrs: { text: "Intro" } },
    "callout-block-01": {
      id: "callout-block-01",
      type: "callout",
      version: 1,
      attrs: {
        pm: { type: "callout", attrs: { "data-block-id": "callout-block-01", variant: "info" }, content: [{ type: "text", text: "Careful" }] },
      },
    },
  },
} as unknown as BlockDocV1

let relay: Relay
let container: HTMLDivElement
let root: Root

const settle = async (ms = 0) => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((resolve) => setTimeout(resolve, ms)))
}
// One act() per tick: React commits state updates (the gate mounting the editor) only when
// an act() scope ends, so a single act() around the whole wait would never see them.
const until = async (check: () => boolean, what: string, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
  }
  await settle()
}
const pm = () => container.querySelector(".ProseMirror")
const serverFragment = (): Y.XmlFragment => relay.server.hocuspocus.documents.get(`post-${POST}`)!.getXmlFragment(EDITOR_FRAGMENT)

beforeEach(async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  relay = await startRelay({ blockDoc: doc, revision: 3 })
  state.relay = relay
  state.user = "1"
  state.themeLoaded = true
  tiptapExtensionRegistry.clear()
  vi.mocked(blockAPIClient.getPostBlocks).mockResolvedValue({
    doc: { doc_version: 1, blocks_order: ["intro-block-0001"], blocks: { "intro-block-0001": doc.blocks["intro-block-0001"] } },
  } as any)
  vi.mocked(blockAPIClient.publishPost).mockResolvedValue({ versionId: 1, versionNo: 1 })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  tiptapExtensionRegistry.clear()
  await relay.destroy()
  vi.restoreAllMocks()
})

async function mount(props: Partial<EditorProps> = {}) {
  const ref = createRef<EditorRef>()
  await act(async () => {
    root.render(<Editor ref={ref} value="" onChange={() => {}} postId={POST} {...props} />)
  })
  return ref
}

describe("Editor", () => {
  it("doesn't connect before the theme has loaded", async () => {
    state.themeLoaded = false
    await mount()
    await settle(20)
    expect(container.textContent).toContain("Loading theme")
    expect(relay.server.hocuspocus.getConnectionsCount()).toBe(0)
  })

  it("binds once the theme's extensions are registered, shows the server's doc and seeds nothing", async () => {
    tiptapExtensionRegistry.register(Callout)
    await mount()
    await until(() => !!pm()?.textContent?.includes("Careful"), "the bound editor")
    expect(pm()!.getAttribute("contenteditable")).toBe("true")
    expect(container.querySelector(".editor-notice")).toBeNull()
    // The server's fragment still has exactly the seeded blocks (no client seed on top).
    expect(serverFragment().toArray().slice(0, 2).map((el) => (el as Y.XmlElement).nodeName)).toEqual(["paragraph", "callout"])
  })

  it("without the theme extension: doesn't bind (the callout survives), shows REST read-only, and refuses writes", async () => {
    const ref = await mount()
    await until(() => !!container.querySelector(".editor-notice"), "the blocked notice")
    expect(container.querySelector(".editor-notice")!.textContent).toContain("callout")
    expect(pm()!.getAttribute("contenteditable")).toBe("false")
    await until(() => !!pm()?.textContent?.includes("Intro"), "the REST copy")
    expect(serverFragment().toArray().map((el) => (el as Y.XmlElement).nodeName)).toContain("callout")
    await expect(ref.current!.publish()).rejects.toThrow(/callout/)
    await expect(ref.current!.restoreVersion(doc)).rejects.toThrow(/callout/)
    expect(blockAPIClient.publishPost).not.toHaveBeenCalled()
  })

  it("a contributor on someone else's post gets a live read-only view", async () => {
    tiptapExtensionRegistry.register(Callout)
    state.user = "3"
    await mount({ readOnly: true })
    await until(() => !!pm()?.textContent?.includes("Careful"), "the live view")
    expect(pm()!.getAttribute("contenteditable")).toBe("false")

    const editor = relay.client("1")
    await editor.whenSynced()
    const { appendParagraph } = await import("../../../collab-server/testkit")
    appendParagraph(editor.doc, "typed by an editor", "blk-live-edit-01")
    await until(() => !!pm()?.textContent?.includes("typed by an editor"), "the live edit")
  })

  it("reports Saving → Saved under StrictMode (effects mount, clean up, mount again)", async () => {
    tiptapExtensionRegistry.register(Callout)
    const ref = createRef<EditorRef>()
    const saves: number[] = []
    await act(async () => {
      root.render(
        <StrictMode>
          <Editor ref={ref} value="" onChange={() => {}} postId={POST} onSaveSuccess={(r) => saves.push(r)} />
        </StrictMode>
      )
    })
    await until(() => !!pm()?.textContent?.includes("Careful"), "the bound editor")
    // TipTap exposes the editor on its DOM node.
    await act(async () => (pm() as any).editor.commands.insertContentAt(1, "typed "))
    expect(ref.current!.getSaveStatus().saveStatus).toBe("saving")
    await until(() => saves.length > 0, "the server's store")
    expect(saves[0]).toBeGreaterThan(3)
    expect(ref.current!.getSaveStatus().saveStatus).toBe("saved")
  })

  it("publishes without a client save: waits for the server to have the edits, then calls publish", async () => {
    tiptapExtensionRegistry.register(Callout)
    const ref = await mount()
    await until(() => !!pm()?.textContent?.includes("Careful"), "the bound editor")
    const result = await act(async () => ref.current!.publish())
    expect(result).toEqual({ versionId: 1, versionNo: 1 })
    expect(blockAPIClient.publishPost).toHaveBeenCalledWith(POST)
  })

  it("turns view-only with a notice when the user is demoted while editing, keeping what's on screen", async () => {
    tiptapExtensionRegistry.register(Callout)
    state.user = "2"
    const onAccessChange = vi.fn()
    const ref = await mount({ onAccessChange })
    await until(() => !!pm()?.textContent?.includes("Careful"), "the bound editor")
    expect(pm()!.getAttribute("contenteditable")).toBe("true")
    await until(() => relay.server.recheckedConnections === 1, "the server to track the connection")

    relay.api.users.set("2", { role: "contributor" })
    await act(async () => relay.clock.advance(RECHECK_MS))
    await until(() => pm()?.getAttribute("contenteditable") === "false", "the editor to turn view-only")
    expect(container.querySelector(".editor-notice")!.textContent).toContain("changed to view-only")
    // The form re-reads the user's role on this (PostForm).
    expect(onAccessChange).toHaveBeenCalledWith({ readOnly: true, reason: "demoted", revoked: false })
    expect(pm()!.textContent).toContain("Careful")
    vi.mocked(blockAPIClient.publishPost).mockClear()
    expect(await ref.current!.publish()).toBeUndefined()
    expect(blockAPIClient.publishPost).not.toHaveBeenCalled()

    // Promoted again: editable, notice gone.
    relay.api.users.set("2", { role: "editor" })
    await act(async () => relay.clock.advance(RECHECK_MS))
    await until(() => pm()?.getAttribute("contenteditable") === "true", "the editor to be editable again")
    expect(container.querySelector(".editor-notice")).toBeNull()
  })

  it("shows 'session ended, sign in again' when the server revokes the session", async () => {
    tiptapExtensionRegistry.register(Callout)
    state.user = "2"
    await mount()
    await until(() => !!pm()?.textContent?.includes("Careful"), "the bound editor")
    await until(() => relay.server.recheckedConnections === 1, "the server to track the connection")

    relay.api.passwordChangedAt.set("2", Math.floor(Date.now() / 1000) + 1)
    await act(async () => relay.clock.advance(RECHECK_MS))
    await until(() => !!container.querySelector("[role=alertdialog]"), "the session-ended dialog")
    const notice = container.querySelector("[role=alertdialog]")!
    expect(notice.textContent).toContain("Your session ended")
    expect(notice.textContent).toContain("Sign in again to keep editing.")
    expect(pm()!.getAttribute("contenteditable")).toBe("false")
    expect(pm()!.textContent).toContain("Careful")

    await act(async () => (notice.querySelector("button") as HTMLButtonElement).click())
    expect(authManager.logout).toHaveBeenCalledWith("session-expired")
  })

  it("remounts on a fresh doc after stale-epoch (block_doc was written around the server)", async () => {
    tiptapExtensionRegistry.register(Callout)
    await mount()
    await until(() => !!pm()?.textContent?.includes("Careful"), "the bound editor")
    await act(async () =>
      relay.restart(() => {
        relay.api.writeAround(String(POST), {
          doc_version: 1,
          blocks_order: ["reseed-block-001"],
          blocks: { "reseed-block-001": { id: "reseed-block-001", type: "paragraph", version: 1, attrs: { text: "Reseeded" } } },
        } as unknown as BlockDocV1)
      })
    )
    await until(() => !!pm()?.textContent?.includes("Reseeded"), "the remount")
    // Once: the old Y.Doc's structs were not merged in.
    expect(pm()!.textContent).not.toContain("Careful")
    expect(paragraphs(relay.api.storedDoc(String(POST))).filter((t) => t === "Reseeded").length).toBeLessThanOrEqual(1)
  })
})
