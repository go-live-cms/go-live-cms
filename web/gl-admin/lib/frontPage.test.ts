import { describe, expect, it } from "vitest"
import {
  LATEST_POSTS,
  canSetFrontPage,
  frontPageHint,
  frontPageOptions,
  frontPageSetMessage,
  frontPageWarning,
  fromFrontPageValue,
  isFrontPage,
  takesFrontPageOffSite,
  toFrontPageValue,
} from "./frontPage"

// The front page (#336): which page it is, who may set it, what Settings offers and
// what the admin says before the home page falls back to the latest posts.

const admin = { id: 1, role: "admin" }
const editor = { id: 2, role: "editor" }
const page = { id: 12, post_type: "page", post_status: "published" }

describe("isFrontPage", () => {
  it("is the chosen page", () => {
    expect(isFrontPage(page, 12)).toBe(true)
    expect(isFrontPage(page, 13)).toBe(false)
    expect(isFrontPage(page, null)).toBe(false)
    expect(isFrontPage(null, 12)).toBe(false)
    // Only pages: a post with the same id never is.
    expect(isFrontPage({ id: 12, post_type: "post" }, 12)).toBe(false)
  })
})

describe("canSetFrontPage", () => {
  it("admins, on a published page that isn't it yet", () => {
    expect(canSetFrontPage(admin, page, null)).toBe(true)
    expect(canSetFrontPage(admin, page, 3)).toBe(true)
    expect(canSetFrontPage(admin, page, 12)).toBe(false)
    expect(canSetFrontPage(editor, page, null)).toBe(false)
    expect(canSetFrontPage(null, page, null)).toBe(false)
    expect(canSetFrontPage(admin, { ...page, post_status: "draft" }, null)).toBe(false)
    expect(canSetFrontPage(admin, { ...page, post_type: "post" }, null)).toBe(false)
  })
})

it("asks before unpublishing, archiving or trashing it", () => {
  expect(["unpublish", "archive", "trash"].every(takesFrontPageOffSite)).toBe(true)
  expect(["publish", "restore", "delete", "duplicate"].some(takesFrontPageOffSite)).toBe(false)
  expect(frontPageWarning("unpublish", "Home")).toEqual({
    title: "Unpublish your front page?",
    description:
      "“Home” is the page your site shows at its home address. While it’s unpublished, the home page shows your latest posts instead. Publish it again to bring it back.",
    confirm: "Unpublish",
  })
  expect(frontPageWarning("archive", "")).toMatchObject({ title: "Archive your front page?", confirm: "Archive" })
  expect(frontPageWarning("archive", "").description).toContain("“Untitled”")
  expect(frontPageWarning("trash", "Home")).toMatchObject({ title: "Move your front page to the trash?", confirm: "Move to trash" })
  expect(frontPageWarning("trash", "Home").description).toContain("While it’s in the trash")
  expect(frontPageSetMessage("Home")).toBe("“Home” is now your front page")
})

describe("Settings' Front page field", () => {
  const pages = [
    { id: 4, title: "Pricing" },
    { id: 2, title: "About" },
    { id: 9, title: "" },
  ]

  it("offers the latest posts, then the published pages by title", () => {
    expect(frontPageOptions(pages, null)).toEqual([
      { value: LATEST_POSTS, label: "Your latest posts" },
      { value: "9", label: "Untitled" },
      { value: "2", label: "About" },
      { value: "4", label: "Pricing" },
    ])
  })

  it("keeps a chosen page that isn't published any more, marked and not choosable", () => {
    const options = frontPageOptions(pages, { id: 12, title: "Home", post_status: "draft" })
    expect(options.at(-1)).toEqual({ value: "12", label: "Home (not published)", disabled: true })
    // Listed once when it is published.
    expect(frontPageOptions(pages, { id: 2, title: "About", post_status: "published" })).toHaveLength(4)
  })

  it("says what the home page shows", () => {
    expect(frontPageHint(null, null)).toEqual({ text: "Your home page lists your latest posts.", warning: false })
    expect(frontPageHint(12, { title: "Home", post_status: "published" }).warning).toBe(false)
    expect(frontPageHint(12, null).warning).toBe(false)
    expect(frontPageHint(12, { title: "Home", post_status: "trash" })).toEqual({
      text: "“Home” isn’t published, so your home page shows your latest posts until it is.",
      warning: true,
    })
  })

  it("maps the select's value to the setting", () => {
    expect(toFrontPageValue(null)).toBe("")
    expect(toFrontPageValue(12)).toBe("12")
    expect(fromFrontPageValue("")).toBeNull()
    expect(fromFrontPageValue("12")).toBe(12)
    expect(fromFrontPageValue("x")).toBeNull()
    expect(fromFrontPageValue("0")).toBeNull()
  })
})
