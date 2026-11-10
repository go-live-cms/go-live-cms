import { describe, it, expect, vi } from "vitest"
import { PostHtmlSnippetsStore, hasHtmlBlock, withWorkingHtml } from "./htmlSnippetsStore"
import type { BlockDocV1 } from "./blocks-spec"

const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"

function api(rows: { id: string; html: string }[] = []) {
  return {
    listHtmlSnippets: vi.fn(async () => rows),
    createHtmlSnippet: vi.fn(async (_postId: number, html: string) => ({ id: B, html: `saved:${html}` })),
    updateHtmlSnippet: vi.fn(async (_postId: number, id: string, html: string) => ({ id, html: `saved:${html}` })),
  }
}

describe("PostHtmlSnippetsStore (#428)", () => {
  it("reads nothing until a block asks", async () => {
    const fake = api()
    const store = new PostHtmlSnippetsStore(12, fake)
    store.refreshIfStarted()
    expect(fake.listHtmlSnippets).not.toHaveBeenCalled()
    store.ensureLoaded()
    store.ensureLoaded()
    await store.refresh()
    expect(fake.listHtmlSnippets).toHaveBeenCalledWith(12)
    expect(store.loaded).toBe(true)
  })

  it("only knows this post's snippets", async () => {
    const store = new PostHtmlSnippetsStore(12, api([{ id: A, html: "<p>a</p>" }]))
    await store.refresh()
    expect(store.get(A)).toBe("<p>a</p>")
    expect(store.get(B)).toBeUndefined()
    expect(store.get(null)).toBeUndefined()
  })

  it("updates a snippet it has, and answers what the server kept", async () => {
    const fake = api([{ id: A, html: "<p>a</p>" }])
    const saved = vi.fn()
    const store = new PostHtmlSnippetsStore(12, fake)
    store.onSaved = saved
    await store.refresh()
    expect(await store.save(A, "<b>new</b>")).toBe(A)
    expect(fake.updateHtmlSnippet).toHaveBeenCalledWith(12, A, "<b>new</b>")
    expect(store.get(A)).toBe("saved:<b>new</b>")
    expect(saved).toHaveBeenCalledTimes(1)
  })

  it("makes a new snippet for a first save, or an id this post doesn't have", async () => {
    const fake = api()
    const store = new PostHtmlSnippetsStore(12, fake)
    await store.refresh()
    expect(await store.save(null, "x")).toBe(B)
    expect(await store.save(A, "y")).toBe(B)
    expect(fake.updateHtmlSnippet).not.toHaveBeenCalled()
    expect(fake.createHtmlSnippet).toHaveBeenCalledTimes(2)
  })

  it("asks again once for a snippet another admin just added", async () => {
    const rows = [{ id: A, html: "a" }]
    const fake = api(rows)
    const store = new PostHtmlSnippetsStore(12, fake)
    await store.refresh()
    expect(fake.listHtmlSnippets).toHaveBeenCalledTimes(1)
    store.requestUnknown(A)
    expect(fake.listHtmlSnippets).toHaveBeenCalledTimes(1)
    store.requestUnknown(B)
    store.requestUnknown(B)
    await vi.waitFor(() => expect(fake.listHtmlSnippets).toHaveBeenCalledTimes(2))
  })

  it("doesn't let a read undo a save made while it was in flight", async () => {
    let answer: (rows: { id: string; html: string }[]) => void = () => {}
    const fake = api([{ id: A, html: "old" }])
    const store = new PostHtmlSnippetsStore(12, fake)
    await store.refresh()
    fake.listHtmlSnippets.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    fake.listHtmlSnippets.mockResolvedValueOnce([{ id: A, html: "saved:new" }])
    const read = store.refresh()
    await store.save(A, "new")
    answer([{ id: A, html: "old" }])
    await read
    await vi.waitFor(() => expect(fake.listHtmlSnippets).toHaveBeenCalledTimes(3))
    expect(store.get(A)).toBe("saved:new")
  })

  it("reports a first read that failed, and recovers", async () => {
    const fake = api([{ id: A, html: "a" }])
    fake.listHtmlSnippets.mockRejectedValueOnce(new Error("down"))
    const store = new PostHtmlSnippetsStore(12, fake)
    await store.refresh()
    expect(store.failed).toBe(true)
    expect(store.loaded).toBe(false)
    await store.refresh()
    expect(store.failed).toBe(false)
    expect(store.get(A)).toBe("a")
  })

  it("flushes the edits still waiting", async () => {
    const store = new PostHtmlSnippetsStore(12, api())
    const pending = vi.fn(async () => {})
    store.track(pending)
    await store.flush()
    expect(pending).toHaveBeenCalledTimes(1)
    store.untrack(pending)
    await store.flush()
    expect(pending).toHaveBeenCalledTimes(1)
  })
})

describe("withWorkingHtml (History's comparison)", () => {
  const doc = {
    doc_version: 1,
    blocks_order: ["a", "b", "c"],
    blocks: {
      a: { id: "a", type: "html", version: 1, attrs: { snippetId: A } },
      b: { id: "b", type: "html", version: 1, attrs: { snippetId: B } },
      c: { id: "c", type: "paragraph", version: 1, attrs: { text: "x" } },
    },
  } as unknown as BlockDocV1

  it("adds each block's working markup without touching the document it was given", () => {
    const out = withWorkingHtml(doc, [{ id: A, html: "<p>a</p>" }])
    expect(out.blocks.a.attrs).toEqual({ snippetId: A, html: "<p>a</p>" })
    expect(out.blocks.b.attrs).toEqual({ snippetId: B })
    expect(doc.blocks.a.attrs).toEqual({ snippetId: A })
  })

  it("says whether a document has any", () => {
    expect(hasHtmlBlock(doc)).toBe(true)
    expect(hasHtmlBlock({ ...doc, blocks: { c: doc.blocks.c } })).toBe(false)
  })
})
