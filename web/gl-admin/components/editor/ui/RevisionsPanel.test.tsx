import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { blockAPIClient, type PostSettingsState, type PostVersion } from "@gl-admin/lib/api/blockAPI"
import { setDiffWorkerFactory } from "@gl-admin/lib/history/diffClient"
import { getHighlightChanges, resetHighlightChanges } from "@gl-admin/lib/history/highlightChanges"
import RevisionsPanel, { VersionPreview } from "./RevisionsPanel"
import { VERSION_ONLY_LABEL, WORKING_ONLY_LABEL } from "./VersionDiff"

// History · 1 with "Highlight changes" (#355): the switch (in memory only, rule 0), the
// preview compared with the working copy read over REST (GET only: the comparison never
// touches the editor or the Yjs doc, and changes nothing), and re-read on a store.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  resetHighlightChanges()
  // jsdom has no Worker: the main-thread fallback runs, same diff.
  setDiffWorkerFactory(null)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  setDiffWorkerFactory(undefined)
})

const para = (id: string, text: string) => ({
  id,
  type: "paragraph",
  version: 1 as const,
  attrs: { pm: { type: "paragraph", attrs: { "data-block-id": id }, content: [{ type: "text", text }] }, text },
})
const docOf = (...blocks: ReturnType<typeof para>[]): BlockDocV1 => ({
  doc_version: 1,
  blocks_order: blocks.map((b) => b.id),
  blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
})

const A = "block-aaaa01"
const B = "block-bbbb02"
const C = "block-cccc03"

const version: PostVersion = {
  id: 9,
  version_no: 3,
  status: "published",
  label: null,
  message: null,
  created_at: "2026-10-26T15:04:00Z",
  created_by: 2,
  created_by_username: "ana",
  doc: docOf(para(A, "Kept the same"), para(B, "Only in the version")),
  settings: { title: "Shipping collaboration", description: "", featured_image: null, term_ids: [] },
}

const settingsState = (title: string): PostSettingsState => ({
  working: { title, description: "", featured_image: null, term_ids: [] },
  published: null,
  changed: false,
  blocks_changed: false,
  has_unpublished_changes: false,
})

async function flush() {
  // The fetches, the time-sliced diff (setTimeout yields) and React's commit.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

function mockApi(working: BlockDocV1 | Record<string, never>, title = "Shipping collaboration in GoLive") {
  const getPostBlocks = vi.spyOn(blockAPIClient, "getPostBlocks").mockResolvedValue({ doc: working as BlockDocV1 })
  const getSettingsState = vi.spyOn(blockAPIClient, "getSettingsState").mockResolvedValue(settingsState(title))
  return { getPostBlocks, getSettingsState }
}

describe("VersionPreview with Highlight changes", () => {
  it("compares the version with the working copy read over REST", async () => {
    const api = mockApi(docOf(para(A, "Kept the same"), para(C, "Only in the working copy")))
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    act(() => root.render(<VersionPreview version={version} postId={42} />))
    expect(container.textContent).toContain("Comparing with the working copy…")
    await flush()

    expect(api.getPostBlocks).toHaveBeenCalledWith(42)
    expect(container.querySelector('[data-testid="version-diff"]')).not.toBeNull()
    expect(container.textContent).toContain(VERSION_ONLY_LABEL)
    expect(container.textContent).toContain(WORKING_ONLY_LABEL)
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "1 only in this version · 1 only in working copy"
    )
    expect(container.textContent).toContain(", compared with the working copy. Read-only.")
    // The title with the working copy's extra words struck through.
    expect(container.querySelector("h1 del")?.textContent).toBe(" in GoLive")
    // Read-only: no write of any kind (the API client was mocked; nothing else fetched).
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("re-reads the working copy when the collab server stored it", async () => {
    const api = mockApi(docOf(para(A, "Kept the same")))
    act(() => root.render(<VersionPreview version={version} postId={42} workingKey={0} />))
    await flush()
    expect(api.getPostBlocks).toHaveBeenCalledTimes(1)

    api.getPostBlocks.mockResolvedValue({ doc: docOf(para(A, "Kept the same"), para(B, "Only in the version")) })
    act(() => root.render(<VersionPreview version={version} postId={42} workingKey={1} />))
    await flush()
    expect(api.getPostBlocks).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Same content as the working copy")
  })

  it("treats an empty working copy ({}) as empty: every block only in the version", async () => {
    mockApi({})
    act(() => root.render(<VersionPreview version={version} postId={42} />))
    await flush()
    expect(container.querySelectorAll(".version-diff__block--version")).toHaveLength(2)
  })

  it("says when it can't compare, and tries again", async () => {
    const api = mockApi(docOf())
    api.getPostBlocks.mockRejectedValueOnce(new Error("Failed to get post blocks: Bad Gateway"))
    act(() => root.render(<VersionPreview version={version} postId={42} />))
    await flush()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Bad Gateway")
    // The version itself still shows.
    expect(container.textContent).toContain("Only in the version")

    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Try again")!
    act(() => retry.click())
    await flush()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('[data-testid="version-diff"]')).not.toBeNull()
  })

  it("only shows the version when the switch is off, and fetches nothing", async () => {
    const api = mockApi(docOf())
    act(() => root.render(<RevisionsPanel postId={42} onView={() => {}} onBackToWorkingCopy={() => {}} />))
    vi.spyOn(blockAPIClient, "listVersions").mockResolvedValue({
      post_status: "published",
      published_version_id: 9,
      versions: [],
    })
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!
    act(() => toggle.click())
    expect(getHighlightChanges()).toBe(false)

    act(() => root.render(<VersionPreview version={version} postId={42} />))
    await flush()
    expect(api.getPostBlocks).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="version-diff"]')).toBeNull()
    expect(container.textContent).toContain("Only in the version")
    expect(container.textContent).not.toContain("compared with the working copy")
  })
})

describe("the Highlight changes switch", () => {
  it("is a labelled switch, on by default, remembered in memory only (rule 0)", async () => {
    vi.spyOn(blockAPIClient, "listVersions").mockResolvedValue({
      post_status: "published",
      published_version_id: null,
      versions: [],
    })
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    act(() => root.render(<RevisionsPanel postId={42} onView={() => {}} onBackToWorkingCopy={() => {}} />))
    await flush()
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!
    const labelId = toggle.getAttribute("aria-labelledby")!
    expect(document.getElementById(labelId)?.textContent).toBe("Highlight changes")
    expect(toggle.getAttribute("aria-checked")).toBe("true")

    act(() => toggle.click())
    expect(toggle.getAttribute("aria-checked")).toBe("false")

    // Remounting the panel (another post, the History tab again) keeps the choice.
    act(() => root.unmount())
    root = createRoot(container)
    act(() => root.render(<RevisionsPanel postId={43} onView={() => {}} onBackToWorkingCopy={() => {}} />))
    await flush()
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false")
    // Nothing on the device: no localStorage or sessionStorage write.
    expect(setItem).not.toHaveBeenCalled()
  })
})
