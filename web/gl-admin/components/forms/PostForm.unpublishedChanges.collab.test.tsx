import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { appendParagraph, paragraphDoc } from "../../../collab-server/testkit"
import { startRelay, POST_ID, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { acquireHocuspocus, releaseHocuspocus } from "@gl-admin/lib/collaboration/HocuspocusCollaboration"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import type { Post } from "@gl-admin/lib/api/types"

// "Changes not published" in the editor (#326), live: user A has a published post open,
// user B edits it, and once the collab server stores B's edit, A's publish bar says the
// changes go live on Update. Updating clears it. The real PostForm, Editor and collab
// server (the in-process relay); only the REST calls are faked, with the API's rule:
// the body is "changed" when the stored working copy differs from the published one.

stubJsdomRangeLayout()

const state = vi.hoisted(() => ({ relay: null as any, published: "" }))

vi.mock("@gl-admin/lib/collaboration/postCollab", () => ({
  acquirePostCollab: (postId: number) => acquireHocuspocus(postId, () => state.relay.client("1")),
  releasePostCollab: (instance: any) => releaseHocuspocus(instance),
}))
vi.mock("@gl-admin/contexts/ThemeContext", () => ({
  useTheme: () => ({ isThemeLoaded: true, themeSlug: "test" }),
}))
const workingCopy = () => JSON.stringify(state.relay.api.posts.get(String(POST_ID)).block_doc)
vi.mock("@gl-admin/lib/api/blockAPI", () => {
  const settings = { title: "A published post", description: "An excerpt here", featured_image: null, term_ids: [] }
  return {
    blockAPIClient: {
      setAuthToken: vi.fn(),
      getPostBlocks: vi.fn(),
      // GET /posts/:id/settings: hashes of the working and published bodies, compared.
      getSettingsState: vi.fn(async () => {
        const changed = workingCopy() !== state.published
        return { working: settings, published: settings, changed: false, blocks_changed: changed, has_unpublished_changes: changed }
      }),
      // Publish snapshots the working copy (the API flushes the collab server first).
      publishPost: vi.fn(async () => {
        state.published = workingCopy()
        return { versionId: 2, versionNo: 2 }
      }),
      unpublishPost: vi.fn(),
      restoreVersionSettings: vi.fn(),
    },
  }
})
const admin = { id: 1, username: "admin", full_name: "Admin", email: "admin@example.com", role: "admin", created_at: "" }
vi.mock("@gl-admin/lib/auth", () => ({
  authManager: {
    getAccessToken: () => "token",
    subscribe: () => () => {},
    getState: () => ({ user: admin }),
    refreshUser: async () => admin,
    logout: vi.fn(async () => {}),
  },
}))
vi.mock("@gl-admin/lib/api/settings", () => ({
  getSettings: async () => ({ post_url_structure: "id", editor_markdown_shortcuts: true }),
}))
vi.mock("@gl-admin/lib/api/posts", () => ({
  createPost: vi.fn(),
  getPostById: vi.fn(),
  updatePost: vi.fn(async () => ({})),
}))
// The settings sidebar loads taxonomies and media; it isn't what's tested here.
// Review requests (#323): none on this post.
vi.mock("@gl-admin/lib/api/reviewRequests", () => ({
  getPostReviewRequest: vi.fn(async () => null),
  getReviewers: vi.fn(async () => []),
  requestReview: vi.fn(),
  dismissReviewRequest: vi.fn(),
  requestReviewChanges: vi.fn(),
}))
vi.mock("@gl-admin/components/editor/ui/PostSidebar", () => ({ default: () => null }))
vi.mock("@gl-admin/components/editor/ui/BubbleMenu", () => ({ default: () => null }))
vi.mock("@gl-admin/components/editor/ui/BlockTypeToolbar", () => ({ default: () => null }))
vi.mock("@gl-admin/components/editor/ui/DragHandle", () => ({ default: () => null }))
vi.mock("@gl-admin/components/editor/ui/MediaSelector", () => ({ default: () => null }))
vi.mock("@gl-admin/components/editor/ui/CharacterCount", () => ({ default: () => null }))

import { blockAPIClient } from "@gl-admin/lib/api/blockAPI"
import PostForm from "./PostForm"

let relay: Relay
let container: HTMLDivElement
let root: Root

const until = async (check: () => boolean, what: string, timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; the bar says "${barText()}"`)
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
  }
}
const bar = () => container.querySelector(".editor-top-bar")
const barText = () => bar()?.textContent ?? ""
const saveState = () => bar()?.querySelector('[role="status"]')?.textContent ?? ""
const pm = () => container.querySelector(".ProseMirror")

const post: Post = {
  id: POST_ID,
  title: "A published post",
  description: "An excerpt here",
  user_id: 1,
  username: "admin",
  url: "a-published-post",
  slug: "a-published-post",
  post_type: "post",
  post_status: "published",
  menu_order: 0,
  created_at: "2026-10-01T10:00:00Z",
  changed_at: "2026-10-01T10:00:00Z",
}

beforeEach(async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  relay = await startRelay({ blockDoc: paragraphDoc("Published text"), revision: 3 })
  state.relay = relay
  // Just published: the working copy is the published one.
  state.published = workingCopy()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  await relay.destroy()
  vi.restoreAllMocks()
})

describe("PostForm: Changes not published (#326)", () => {
  it("shows the hint on A's publish bar once B's edit is stored, and clears it on Update", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <PostForm mode="edit" initialData={post} contentType="post" />
        </MemoryRouter>
      )
    })
    await until(() => !!pm()?.textContent?.includes("Published text"), "A's bound editor")
    await until(() => vi.mocked(blockAPIClient.getSettingsState).mock.calls.length > 0, "the first state read")
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(saveState()).toBe("Saved")
    expect(barText()).toContain("Published")
    expect(barText()).not.toContain("Changes not published")

    // User B types in the same post; nothing local happened in A's tab.
    const b = relay.client("2")
    await b.whenSynced()
    appendParagraph(b.doc, "typed by B after the publish", "blk-b-after-publish")
    await until(() => !!pm()?.textContent?.includes("typed by B"), "B's edit in A's editor")
    await until(() => saveState() === "Saved · changes go live on Update", "the hint after the store")
    expect(barText()).toContain("Changes not published")
    expect(relay.api.puts.length).toBeGreaterThan(0)

    // A updates: the snapshot takes the working copy, and the hint goes.
    const update = [...bar()!.querySelectorAll("button")].find((b) => b.textContent === "Update")!
    await act(async () => update.click())
    await until(() => vi.mocked(blockAPIClient.publishPost).mock.calls.length === 1, "the publish")
    await until(() => saveState() === "Saved", "the hint to clear")
    expect(barText()).not.toContain("Changes not published")
  })
})
