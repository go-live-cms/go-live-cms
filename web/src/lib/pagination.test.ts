import { describe, expect, it } from "vitest"
import { pageLinks, pagePath, pageTitleSuffix, pageWindow, parsePageSegment, resolveListRequest } from "./pagination"

const url = (path: string) => new URL(path, "https://example.org")

describe("pagePath", () => {
  it("gives page 1 no suffix and later pages /page/N/", () => {
    expect(pagePath("/", 1)).toBe("/")
    expect(pagePath("/", 2)).toBe("/page/2/")
    expect(pagePath("/post", 1)).toBe("/post")
    expect(pagePath("/post", 3)).toBe("/post/page/3/")
    expect(pagePath("/category/guides/", 2)).toBe("/category/guides/page/2/")
  })
})

describe("pageLinks", () => {
  it("has no links when everything fits on one page", () => {
    expect(pageLinks("/", 1, 1)).toEqual({ newer: undefined, older: undefined })
    expect(pageLinks("/", 1, 0)).toEqual({ newer: undefined, older: undefined })
  })

  it("links older pages from the first and newer back to the bare path", () => {
    expect(pageLinks("/post", 1, 3)).toEqual({ newer: undefined, older: "/post/page/2/" })
    expect(pageLinks("/post", 2, 3)).toEqual({ newer: "/post", older: "/post/page/3/" })
    expect(pageLinks("/post", 3, 3)).toEqual({ newer: "/post/page/2/", older: undefined })
  })
})

describe("pageWindow", () => {
  it("shows the design's 1 2 3 … 5 on page 1 of 5", () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, "gap", 5])
  })

  it("keeps the current page's neighbours, the first and the last", () => {
    expect(pageWindow(5, 9)).toEqual([1, "gap", 4, 5, 6, "gap", 9])
    expect(pageWindow(9, 9)).toEqual([1, "gap", 7, 8, 9])
    expect(pageWindow(3, 7)).toEqual([1, 2, 3, 4, "gap", 7])
    expect(pageWindow(4, 7)).toEqual([1, "gap", 3, 4, 5, "gap", 7])
  })

  it("has no gap when nothing is hidden", () => {
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5])
    expect(pageWindow(1, 4)).toEqual([1, 2, 3, 4])
    expect(pageWindow(1, 3)).toEqual([1, 2, 3])
  })

  it("is empty for a single page and short for two", () => {
    expect(pageWindow(1, 0)).toEqual([])
    expect(pageWindow(1, 1)).toEqual([])
    expect(pageWindow(2, 2)).toEqual([1, 2])
  })
})

describe("parsePageSegment", () => {
  it("accepts positive integers written plainly", () => {
    expect(parsePageSegment("2")).toBe(2)
    expect(parsePageSegment("1")).toBe(1)
    for (const bad of [undefined, "", "0", "02", "-1", "2.5", "two", "1e3", "9999999999"]) {
      expect(parsePageSegment(bad)).toBeNull()
    }
  })
})

describe("resolveListRequest", () => {
  it("serves page 1 on the base path and page N on /page/N/", () => {
    expect(resolveListRequest(url("/"), "/")).toEqual({ kind: "page", page: 1 })
    expect(resolveListRequest(url("/page/3/"), "/", "3")).toEqual({ kind: "page", page: 3 })
    expect(resolveListRequest(url("/post/page/2"), "/post", "2")).toEqual({ kind: "page", page: 2 })
  })

  it("redirects ?page= to the clean URL, keeping other parameters", () => {
    expect(resolveListRequest(url("/?page=2"), "/")).toEqual({ kind: "redirect", location: "/page/2/" })
    expect(resolveListRequest(url("/post?page=3&utm=x"), "/post")).toEqual({ kind: "redirect", location: "/post/page/3/?utm=x" })
    expect(resolveListRequest(url("/post?page=1"), "/post")).toEqual({ kind: "redirect", location: "/post" })
    expect(resolveListRequest(url("/post?page=abc"), "/post")).toEqual({ kind: "redirect", location: "/post" })
    expect(resolveListRequest(url("/post/page/4/?page=9"), "/post", "4")).toEqual({ kind: "redirect", location: "/post/page/4/" })
  })

  it("redirects /page/1/ to the base path", () => {
    expect(resolveListRequest(url("/page/1/"), "/", "1")).toEqual({ kind: "redirect", location: "/" })
    expect(resolveListRequest(url("/post/page/1/"), "/post", "1")).toEqual({ kind: "redirect", location: "/post" })
  })

  it("404s a segment that isn't a page number", () => {
    expect(resolveListRequest(url("/page/0/"), "/", "0")).toEqual({ kind: "notFound" })
    expect(resolveListRequest(url("/post/page/x/"), "/post", "x")).toEqual({ kind: "notFound" })
    expect(resolveListRequest(url("/post/page/x/?page=2"), "/post", "x")).toEqual({ kind: "notFound" })
  })
})

describe("pageTitleSuffix", () => {
  it("names pages after the first", () => {
    expect(pageTitleSuffix(1)).toBe("")
    expect(pageTitleSuffix(2)).toBe(" · Page 2")
  })
})
