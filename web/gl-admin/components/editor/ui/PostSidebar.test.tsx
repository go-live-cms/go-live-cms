import { StrictMode, act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"
import type { Post } from "@gl-admin/lib/api/types"

// The tab callback's return value must not become the effect's cleanup: PostForm's
// `(tab) => (settingsTab.current = tab)` returns the tab, and React then called "post" as
// a function, taking the whole post editor down when it opened in development (StrictMode
// runs the cleanup at once) and when leaving it in production.

vi.mock("@gl-admin/lib/hooks/useFeaturedImage", () => ({
  useFeaturedImage: () => ({ featuredImage: null, loading: false, error: null, setImage: vi.fn(), refetch: vi.fn() }),
}))
vi.mock("@gl-admin/lib/hooks/useSiteSettings", () => ({ useSiteDateSettings: () => null }))
vi.mock("./FeaturedImage", () => ({ default: () => null }))
vi.mock("./RevisionsPanel", () => ({ default: () => null }))
vi.mock("./PostTaxonomies", () => ({ default: () => null }))
vi.mock("./PostAuthors", () => ({ default: () => null }))
vi.mock("./PostOwner", () => ({ default: () => null }))
vi.mock("./PostSeoPanel", () => ({ default: () => null }))
vi.mock("./PageTemplateField", () => ({ default: () => null }))
vi.mock("./BlockSettingsPanel", () => ({ default: () => null }))
vi.mock("./PostDiscussion", () => ({
  default: ({ postId, postType, published }: { postId: number; postType: string; published: boolean }) => (
    <section data-testid="post-discussion" data-post={`${postId}:${postType}:${published ? "published" : "draft"}`} />
  ),
}))

import PostSidebar, { type SettingsTab } from "./PostSidebar"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe("PostSidebar", () => {
  it("survives a tab callback that returns a value, mounting and unmounting", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    const current: { tab?: SettingsTab } = {}
    const onCaughtError = vi.spyOn(console, "error").mockImplementation(() => {})

    act(() => {
      root.render(
        <StrictMode>
          <PostSidebar
            post={{ id: 1, title: "T", post_type: "post", post_status: "draft", description: "" } as Post}
            onUpdate={() => {}}
            isVisible
            onToggle={() => {}}
            sidebarWidth="320px"
            onResize={() => {}}
            urlStructure="id"
            mode="create"
            onTabChange={(tab) => (current.tab = tab)}
          />
        </StrictMode>
      )
    })
    expect(current.tab).toBe("post")
    expect(() => act(() => root.unmount())).not.toThrow()
    expect(onCaughtError.mock.calls.flat().join(" ")).not.toContain("must not return anything besides a function")

    onCaughtError.mockRestore()
    container.remove()
  })

  // #527: the Post tab ends with Discussion for editors and admins (PostForm passes
  // `discussion` only for them, decision 3), and only once the post exists.
  it.each([
    ["an editor's post", true, "edit", 1, true],
    ["a contributor's view", false, "edit", 1, false],
    ["a new post", true, "create", 0, false],
  ] as const)("Discussion section: %s", (_, discussion, mode, id, shown) => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        <PostSidebar
          post={{ id, title: "T", post_type: "post", post_status: "published", description: "" } as Post}
          onUpdate={() => {}}
          isVisible
          onToggle={() => {}}
          sidebarWidth="320px"
          onResize={() => {}}
          urlStructure="id"
          mode={mode}
          discussion={discussion}
        />
      )
    })
    const section = container.querySelector("[data-testid='post-discussion']")
    expect(section !== null).toBe(shown)
    if (shown) {
      // Last in the Post tab's fieldset, so a read-only panel disables it with the rest.
      const fieldset = container.querySelector("fieldset.post-settings__fieldset")!
      expect(fieldset.lastElementChild).toBe(section)
      expect(section!.getAttribute("data-post")).toBe("1:post:published")
    }
    act(() => root.unmount())
    container.remove()
  })
})
