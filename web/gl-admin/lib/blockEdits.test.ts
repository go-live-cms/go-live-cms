import { describe, expect, it, vi } from "vitest"
import type { PostBlockEdits } from "./api/blockEdits"
import { FORMER_MEMBER, lastEditedLine } from "./blockEdits"
import { PostBlockEditsStore } from "./blockEditsStore"

// Per-block "Last edited by" (#328): the block menu's wording, and how the store stays
// current (read on open and reconnect, merged from the server's `stored` messages).

const now = new Date("2026-11-06T15:00:00Z")
const ana = { id: 8, username: "ana", full_name: "Ana Costa", avatar: null }
const kenji = { id: 9, username: "kenji", full_name: "", avatar: null }

const storeWith = (data: PostBlockEdits | (() => Promise<PostBlockEdits>)) => {
  const getPostBlockEdits = vi.fn(typeof data === "function" ? data : async () => structuredClone(data))
  return { store: new PostBlockEditsStore(5, { getPostBlockEdits }), getPostBlockEdits }
}

describe("lastEditedLine", () => {
  it("names the editor and says when, as the lists do", async () => {
    const { store } = storeWith({
      a: { user: ana, edited_at: "2026-11-06T13:00:00Z" },
      b: { user: kenji, edited_at: "2026-11-06T14:59:30Z" },
      c: { user: null, edited_at: "2026-10-24T09:00:00Z" },
      d: { user: ana, edited_at: "2026-11-05T09:00:00Z" },
    })
    await store.refresh()
    const s = store.getSnapshot()
    expect(lastEditedLine(s, "a", 1, now)).toBe("Last edited by Ana Costa · 2 hours ago")
    // No full name: the username. Just now and yesterday in lower case, mid-sentence.
    expect(lastEditedLine(s, "b", 1, now)).toBe("Last edited by kenji · just now")
    // A member removed since.
    expect(lastEditedLine(s, "c", 1, now)).toBe(`Last edited by ${FORMER_MEMBER} · Oct 24`)
    expect(lastEditedLine(s, "d", 1, now)).toBe("Last edited by Ana Costa · yesterday")
    // The viewer.
    expect(lastEditedLine(s, "a", 8, now)).toBe("Last edited by you · 2 hours ago")
    // No attribution, no block id: no line.
    expect(lastEditedLine(s, "zzz", 1, now)).toBeNull()
    expect(lastEditedLine(s, undefined, 1, now)).toBeNull()
  })
})

describe("PostBlockEditsStore", () => {
  it("merges a stored message's rows, newest wins, and reads again once for a user it can't name", async () => {
    const { store, getPostBlockEdits } = storeWith({ a: { user: ana, edited_at: "2026-11-06T13:00:00Z" } })
    await store.refresh()
    const seen = vi.fn()
    store.subscribe(seen)

    store.applyStored([{ block_id: "a", user_id: 8, edited_at: "2026-11-06T14:00:00Z" }])
    expect(store.getSnapshot().edits.get("a")).toEqual({ userId: 8, editedAt: "2026-11-06T14:00:00Z" })
    expect(seen).toHaveBeenCalled()
    // An older row (a late message) doesn't undo a newer one.
    store.applyStored([{ block_id: "a", user_id: 9, edited_at: "2026-11-06T13:30:00Z" }])
    expect(store.getSnapshot().edits.get("a")?.userId).toBe(8)
    expect(getPostBlockEdits).toHaveBeenCalledTimes(1)

    // User 9 isn't known: no line until the read brings their name, and only one read.
    getPostBlockEdits.mockResolvedValue({ b: { user: kenji, edited_at: "2026-11-06T14:10:00Z" } })
    store.applyStored([{ block_id: "b", user_id: 9, edited_at: "2026-11-06T14:10:00Z" }])
    expect(lastEditedLine(store.getSnapshot(), "b", 1, now)).toBeNull()
    store.applyStored([{ block_id: "b", user_id: 9, edited_at: "2026-11-06T14:11:00Z" }])
    await vi.waitFor(() => expect(lastEditedLine(store.getSnapshot(), "b", 1, now)).toBe("Last edited by kenji · 49 minutes ago"))
    expect(getPostBlockEdits).toHaveBeenCalledTimes(2)
  })

  it("never lets a read in flight undo a row merged meanwhile", async () => {
    let answer: (data: PostBlockEdits) => void = () => {}
    const { store } = storeWith(() => new Promise<PostBlockEdits>((resolve) => (answer = resolve)))
    const reading = store.refresh()
    store.applyStored([{ block_id: "a", user_id: 8, edited_at: "2026-11-06T14:00:00Z" }])
    // The read started before that store committed: its row for "a" is older.
    answer({ a: { user: kenji, edited_at: "2026-11-06T13:00:00Z" }, c: { user: ana, edited_at: "2026-11-06T12:00:00Z" } })
    await reading
    const { edits, users, loaded } = store.getSnapshot()
    expect(loaded).toBe(true)
    expect(edits.get("a")).toEqual({ userId: 8, editedAt: "2026-11-06T14:00:00Z" })
    expect(edits.get("c")?.userId).toBe(8)
    expect(users.get(9)?.username).toBe("kenji")
  })

  it("keeps what it had when a read fails, and ignores malformed rows", async () => {
    const { store, getPostBlockEdits } = storeWith({ a: { user: ana, edited_at: "2026-11-06T13:00:00Z" } })
    await store.refresh()
    getPostBlockEdits.mockRejectedValue(new Error("offline"))
    await store.refresh()
    expect(store.getSnapshot().edits.get("a")?.userId).toBe(8)
    store.applyStored([{ block_id: 3 as unknown as string, user_id: 8, edited_at: "x" }])
    store.applyStored(undefined)
    expect([...store.getSnapshot().edits.keys()]).toEqual(["a"])
  })

  it("coalesces reads asked for while one runs, and stops after destroy", async () => {
    let answers = 0
    const { store, getPostBlockEdits } = storeWith(async () => {
      answers++
      return {}
    })
    await Promise.all([store.refresh(), store.refresh(), store.refresh()])
    await vi.waitFor(() => expect(answers).toBe(2))
    store.destroy()
    await store.refresh()
    expect(getPostBlockEdits).toHaveBeenCalledTimes(2)
  })
})
