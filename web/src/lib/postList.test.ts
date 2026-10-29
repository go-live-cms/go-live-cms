import { describe, expect, it } from "vitest"
import { pageLinks, pageNumber } from "./postList"
import { themeLayoutCandidates } from "./themeLayout"

describe("pageNumber", () => {
  it("reads ?page=, 1 for anything else", () => {
    expect(pageNumber("3")).toBe(3)
    expect(pageNumber(null)).toBe(1)
    expect(pageNumber("1")).toBe(1)
    expect(pageNumber("0")).toBe(1)
    expect(pageNumber("-2")).toBe(1)
    expect(pageNumber("2.5")).toBe(1)
    expect(pageNumber("abc")).toBe(1)
  })
})

describe("pageLinks", () => {
  it("has no links when everything fits on one page", () => {
    expect(pageLinks("/", 1, 10, 7)).toEqual({ newer: undefined, older: undefined })
  })

  it("links older pages from the first and newer back to the bare path", () => {
    expect(pageLinks("/post", 1, 10, 25)).toEqual({ newer: undefined, older: "/post?page=2" })
    expect(pageLinks("/post", 2, 10, 25)).toEqual({ newer: "/post", older: "/post?page=3" })
    expect(pageLinks("/post", 3, 10, 25)).toEqual({ newer: "/post?page=2", older: undefined })
  })

  it("points newer at the last page from past the end", () => {
    expect(pageLinks("/", 9, 10, 25).newer).toBe("/?page=3")
  })
})

describe("themeLayoutCandidates", () => {
  it("tries the theme's variant, its default, then the default theme's", () => {
    expect(themeLayoutCandidates("../../themes", "magazine", "home")).toEqual([
      "../../themes/magazine/layouts/home/default.astro",
      "../../themes/default/layouts/home/default.astro",
    ])
    expect(themeLayoutCandidates("../themes", "default", "post", "wide")).toEqual([
      "../themes/default/layouts/post/wide.astro",
      "../themes/default/layouts/post/default.astro",
    ])
  })
})
