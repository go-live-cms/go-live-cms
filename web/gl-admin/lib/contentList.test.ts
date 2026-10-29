import { describe, expect, it } from "vitest"
import {
  editedPhrase,
  findSort,
  findTab,
  formatLastEdited,
  lastEdited,
  listTabs,
  postAccess,
  rowActions,
  tabCount,
  totalCount,
} from "./contentList"

// The posts list's rules (#340): status tabs and their counts, the contributor's
// access column, the row actions and "last edited".

const editor = { id: 1, role: "editor" }
const contributor = { id: 7, role: "contributor" }

const post = (over: Record<string, unknown> = {}) => ({
  user_id: 7,
  username: "elena",
  post_status: "draft",
  authors: [{ id: 7, username: "elena", full_name: "Elena V." }],
  ...over,
})

describe("status tabs", () => {
  it("gives moderators All, Published, Drafts and Archived", () => {
    expect(listTabs("editor").map((t) => t.id)).toEqual(["all", "published", "draft", "archived"])
    expect(listTabs("admin").map((t) => t.id)).toEqual(["all", "published", "draft", "archived"])
  })

  it("gives contributors All, My posts and Published", () => {
    expect(listTabs("contributor").map((t) => t.id)).toEqual(["all", "mine", "published"])
    expect(listTabs("contributor")[1]).toMatchObject({ mine: true, status: "" })
  })

  it("falls back to the first tab for an unknown ?view", () => {
    const tabs = listTabs("editor")
    expect(findTab(tabs, "draft").id).toBe("draft")
    expect(findTab(tabs, "trash").id).toBe("all")
    expect(findTab(tabs, null).id).toBe("all")
  })
})

describe("tabCount", () => {
  const counts = { draft: 12, published: 31, archived: 4 }
  const tabs = listTabs("editor")

  it("counts All without archived posts", () => {
    expect(tabCount(findTab(tabs, "all"), counts)).toBe(43)
  })

  it("counts one status", () => {
    expect(tabCount(findTab(tabs, "published"), counts)).toBe(31)
    expect(tabCount(findTab(tabs, "draft"), counts)).toBe(12)
    expect(tabCount(findTab(tabs, "archived"), counts)).toBe(4)
  })

  it("is 0 for a status nobody has", () => {
    expect(tabCount(findTab(tabs, "archived"), { draft: 2 })).toBe(0)
    expect(tabCount(findTab(tabs, "all"), {})).toBe(0)
  })

  it("is null (a skeleton) while the counts load", () => {
    expect(tabCount(findTab(tabs, "all"), null)).toBeNull()
  })

  it("counts My posts from the user's own counts, every status", () => {
    const mine = findTab(listTabs("contributor"), "mine")
    expect(tabCount(mine, counts, { draft: 2, published: 1, archived: 1 })).toBe(4)
    expect(tabCount(mine, counts, null)).toBeNull()
  })

  it("totals every status for the empty state", () => {
    expect(totalCount(counts)).toBe(47)
    expect(totalCount({})).toBe(0)
    expect(totalCount(null)).toBeNull()
  })
})

describe("postAccess (Your access)", () => {
  it("lets a contributor edit their own draft", () => {
    expect(postAccess(contributor, post())).toEqual({ canEdit: true, note: "your draft" })
  })

  it("lets a contributor edit their own published post; an editor publishes it", () => {
    expect(postAccess(contributor, post({ post_status: "published" }))).toEqual({
      canEdit: true,
      note: "an editor publishes your changes",
    })
  })

  it("lets a contributor edit their own archived post", () => {
    expect(postAccess(contributor, post({ post_status: "archived" })).canEdit).toBe(true)
  })

  it("makes other people's posts view-only, at any status", () => {
    for (const status of ["draft", "published", "archived"]) {
      const other = post({ user_id: 3, username: "kenji", post_status: status, authors: [{ id: 3, username: "kenji", full_name: "Kenji T." }] })
      expect(postAccess(contributor, other)).toEqual({ canEdit: false, note: undefined })
    }
  })

  it("explains view-only when the contributor is credited but doesn't own it", () => {
    const credited = post({
      user_id: 5,
      username: "sofia",
      post_status: "published",
      authors: [
        { id: 5, username: "sofia", full_name: "Sofia L." },
        { id: 7, username: "elena", full_name: "Elena V." },
      ],
    })
    expect(postAccess(contributor, credited)).toEqual({ canEdit: false, note: "You’re credited · Sofia L. owns it" })
  })

  it("names the owner by username when the byline lacks them", () => {
    const credited = post({ user_id: 5, username: "sofia", authors: [{ id: 7, username: "elena", full_name: "" }] })
    expect(postAccess(contributor, credited).note).toBe("You’re credited · sofia owns it")
  })

  it("lets moderators edit everything, without a note", () => {
    expect(postAccess(editor, post({ user_id: 99 }))).toEqual({ canEdit: true })
  })

  it("gives nobody edit access when signed out", () => {
    expect(postAccess(null, post()).canEdit).toBe(false)
  })
})

describe("rowActions", () => {
  it("offers moderators publish, archive and delete on a draft", () => {
    expect(rowActions(editor, post())).toEqual(["publish", "archive", "delete"])
  })

  it("offers unpublish on a published post", () => {
    expect(rowActions(editor, post({ post_status: "published" }))).toEqual(["unpublish", "archive", "delete"])
  })

  it("doesn't archive an archived post again", () => {
    expect(rowActions(editor, post({ post_status: "archived" }))).toEqual(["publish", "delete"])
  })

  it("lets a contributor only delete their own unpublished post", () => {
    expect(rowActions(contributor, post())).toEqual(["delete"])
    expect(rowActions(contributor, post({ post_status: "published" }))).toEqual([])
    expect(rowActions(contributor, post({ user_id: 3 }))).toEqual([])
  })
})

describe("sort", () => {
  it("defaults to Last edited", () => {
    expect(findSort(null)).toMatchObject({ id: "edited", sort: "changed_at", order: "desc" })
    expect(findSort("title")).toMatchObject({ sort: "title", order: "asc" })
    expect(findSort("nope").id).toBe("edited")
  })
})

describe("last edited", () => {
  it("uses created_at for posts never changed (the 0001 sentinel)", () => {
    expect(lastEdited({ created_at: "2026-10-20T10:00:00Z", changed_at: "0001-01-01T00:00:00Z" })).toBe("2026-10-20T10:00:00Z")
    expect(lastEdited({ created_at: "2026-10-20T10:00:00Z", changed_at: "2026-10-22T10:00:00Z" })).toBe("2026-10-22T10:00:00Z")
  })

  const now = new Date(2026, 9, 27, 15, 0, 0)
  const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo, d, h, mi, s).toISOString()

  it("reads relative for today and yesterday, then as a date", () => {
    expect(formatLastEdited(at(2026, 9, 27, 14, 59, 30), now)).toBe("Just now")
    expect(formatLastEdited(at(2026, 9, 27, 14, 55), now)).toBe("5 minutes ago")
    expect(formatLastEdited(at(2026, 9, 27, 14, 0), now)).toBe("1 hour ago")
    expect(formatLastEdited(at(2026, 9, 27, 1, 0), now)).toBe("14 hours ago")
    expect(formatLastEdited(at(2026, 9, 26, 23, 0), now)).toBe("Yesterday")
    expect(formatLastEdited(at(2026, 9, 24, 9, 0), now)).toBe("Oct 24")
    expect(formatLastEdited(at(2025, 7, 12, 9, 0), now)).toBe("Aug 12, 2025")
  })

  it("treats a time ahead of the clock as just now", () => {
    expect(formatLastEdited(at(2026, 9, 27, 16, 0), now)).toBe("Just now")
  })

  it("phrases it for a sentence", () => {
    expect(editedPhrase(at(2026, 9, 27, 14, 59, 30), now)).toBe("Edited just now")
    expect(editedPhrase(at(2026, 9, 26, 9, 0), now)).toBe("Edited yesterday")
    expect(editedPhrase(at(2026, 9, 27, 13, 0), now)).toBe("Edited 2 hours ago")
    expect(editedPhrase(at(2026, 9, 22, 9, 0), now)).toBe("Edited Oct 22")
  })
})
