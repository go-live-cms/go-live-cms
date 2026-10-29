import { describe, expect, it } from "vitest"
import { bylinePeople, displayName, nameSeparator, postCountLabel, safeWebsite, websiteLabel } from "./authors"
import { avatarColor } from "./avatar"

describe("bylinePeople", () => {
  it("links every credited author to their page, full name first", () => {
    expect(
      bylinePeople(
        [
          { username: "ana", full_name: "Ana Costa" },
          { username: "luan dev", full_name: " " },
        ],
        { user_id: 1, username: "owner" },
      ),
    ).toEqual([
      { name: "Ana Costa", key: "ana", href: "/author/ana" },
      { name: "luan dev", key: "luan dev", href: "/author/luan%20dev" },
    ])
  })

  it("falls back to the owner, unlinked: they may not be credited on anything", () => {
    // Keyed by username like credited authors, so the owner's colour matches theirs.
    expect(bylinePeople([], { user_id: 7, username: "owner" })).toEqual([{ name: "owner", key: "owner" }])
    expect(bylinePeople(undefined, {})).toEqual([])
  })
})

describe("nameSeparator", () => {
  it('joins "Ana", "Ana and Luan", "Ana, Luan and Priya"', () => {
    const join = (names: string[]) => names.map((n, i) => nameSeparator(i, names.length) + n).join("")
    expect(join(["Ana"])).toBe("Ana")
    expect(join(["Ana", "Luan"])).toBe("Ana and Luan")
    expect(join(["Ana", "Luan", "Priya"])).toBe("Ana, Luan and Priya")
  })
})

describe("website", () => {
  it("links only absolute http(s) URLs", () => {
    expect(safeWebsite("https://anacosta.example")).toBe("https://anacosta.example/")
    expect(safeWebsite(" http://a.example/about ")).toBe("http://a.example/about")
    expect(safeWebsite("javascript:alert(1)")).toBeNull()
    expect(safeWebsite("data:text/html,hi")).toBeNull()
    expect(safeWebsite("anacosta.example")).toBeNull()
    expect(safeWebsite("")).toBeNull()
    expect(safeWebsite(undefined)).toBeNull()
  })

  it("shows the host and path without the scheme, www. or a trailing slash", () => {
    expect(websiteLabel("https://www.anacosta.example/")).toBe("anacosta.example")
    expect(websiteLabel("https://anacosta.example/about/")).toBe("anacosta.example/about")
  })
})

describe("labels", () => {
  it("names and counts", () => {
    expect(displayName({ username: "ana", full_name: "Ana Costa" })).toBe("Ana Costa")
    expect(displayName({ username: "ana", full_name: "" })).toBe("ana")
    expect(postCountLabel(1)).toBe("1 post")
    expect(postCountLabel(4)).toBe("4 posts")
  })

  it("keys avatar colours by username, so cards, bylines and the page agree", () => {
    expect(avatarColor("ana")).toBe(avatarColor("ana"))
    expect(new Set(["ana", "luan", "priya", "kenji", "sofia", "elena"].map(avatarColor)).size).toBeGreaterThan(1)
  })
})
