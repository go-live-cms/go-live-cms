import { describe, expect, it } from "vitest"
import { ApiError } from "./api/errors"
import {
  appendRedirects,
  creatorName,
  isExternal,
  normalizeFrom,
  redirectCount,
  redirectErrorMessage,
  sourceDescription,
  statusLabel,
  validateFrom,
  validateRedirect,
  validateTo,
} from "./redirects"
import type { Redirect } from "./api/redirects"

// Settings › URLs & redirects (#331): the add form mirrors the API's rules.

describe("isExternal", () => {
  it("is true for absolute http(s) links only", () => {
    expect(isExternal("https://example.com/a")).toBe(true)
    expect(isExternal(" HTTP://example.com")).toBe(true)
    expect(isExternal("/blog/new")).toBe(false)
    expect(isExternal("ftp://example.com")).toBe(false)
  })
})

describe("the From address", () => {
  it("drops a trailing slash, as the API does", () => {
    expect(normalizeFrom(" /blog/old/ ")).toBe("/blog/old")
    expect(normalizeFrom("/")).toBe("/")
  })

  it("must be a path on this site", () => {
    expect(validateFrom("/blog/collab-preview")).toBeUndefined()
    expect(validateFrom("")).toMatch(/Enter the old address/)
    expect(validateFrom("blog/old")).toMatch(/single \//)
    expect(validateFrom("//evil.example")).toMatch(/single \//)
    expect(validateFrom("https://example.com/old")).toMatch(/without the domain/)
    expect(validateFrom("/old page")).toMatch(/spaces/)
    expect(validateFrom("/old?id=2")).toMatch(/\? or #/)
    expect(validateFrom("/old#top")).toMatch(/\? or #/)
  })

  it("can't be under the admin, the API or static files", () => {
    expect(validateFrom("/gl-admin/settings")).toBe("Addresses under /gl-admin can’t be redirected.")
    expect(validateFrom("/api")).toBe("Addresses under /api can’t be redirected.")
    expect(validateFrom("/uploads/a.png")).toMatch(/\/uploads/)
    expect(validateFrom("/themes/default/x.css")).toMatch(/\/themes/)
    // Only whole segments
    expect(validateFrom("/apiary")).toBeUndefined()
  })
})

describe("the To address", () => {
  it("is a site path or a complete http(s) link", () => {
    expect(validateTo("/blog/new-address")).toBeUndefined()
    expect(validateTo("https://example.com/page")).toBeUndefined()
    expect(validateTo("")).toMatch(/Enter the new address/)
    expect(validateTo("blog/new")).toMatch(/Start with \//)
    expect(validateTo("//cdn.example.com")).toMatch(/Start with \//)
    expect(validateTo("https://")).toMatch(/isn’t complete/)
    expect(validateTo("/a b")).toMatch(/spaces/)
  })

  it("can't be the From address", () => {
    expect(validateRedirect("/old/", "/old")).toEqual({ to: "The new address is the same as the old one." })
    expect(validateRedirect("/old", "/new")).toEqual({})
    expect(validateRedirect("", "")).toEqual({ from: expect.any(String), to: expect.any(String) })
  })
})

it("maps the API's codes to the field they're about", () => {
  expect(redirectErrorMessage(new ApiError("x", 409, null, "redirect_exists"), "/old/")).toEqual({
    field: "from",
    message: "/old already redirects somewhere. Delete that redirect first.",
  })
  expect(redirectErrorMessage(new ApiError("x", 400, null, "redirect_loop"), "/a").field).toBe("to")
  expect(redirectErrorMessage(new ApiError("From path is invalid.", 400), "/a")).toEqual({ field: null, message: "From path is invalid." })
})

describe("rows", () => {
  const row = (over: Partial<Redirect>): Redirect => ({
    id: 1,
    from_path: "/a",
    to_path: "/b",
    status_code: 301,
    source: "manual",
    external: false,
    created_at: "2026-11-01T00:00:00Z",
    created_by: { id: 2, username: "ana", full_name: "Ana Costa", avatar: null },
    ...over,
  })

  it("names who added it, or says GoLive did", () => {
    expect(creatorName(row({}))).toBe("Ana Costa")
    expect(creatorName(row({ created_by: { id: 2, username: "ana", full_name: "", avatar: null } }))).toBe("ana")
    expect(creatorName(row({ created_by: null, source: "term" }))).toBe("Automatic")
    expect(creatorName(row({ created_by: null }))).toBe("A former member")
  })

  it("labels the status and the source", () => {
    expect(statusLabel(301)).toBe("Permanent")
    expect(statusLabel(302)).toBe("Temporary")
    expect(sourceDescription("manual")).toBeNull()
    expect(sourceDescription("merge")).toBe("Added automatically when tags were merged")
    expect(redirectCount(1)).toBe("1 redirect")
    expect(redirectCount(6)).toBe("6 redirects")
  })

  it("appends a page without repeating rows", () => {
    expect(appendRedirects([row({ id: 3 }), row({ id: 2 })], [row({ id: 2 }), row({ id: 1 })]).map((r) => r.id)).toEqual([3, 2, 1])
  })
})
