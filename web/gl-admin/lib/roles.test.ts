import { describe, expect, it } from "vitest"
import { canEditContent, isSiteAdmin } from "./roles"

describe("isSiteAdmin", () => {
  it("allows only admins", () => {
    expect(isSiteAdmin("admin")).toBe(true)
    expect(isSiteAdmin("Admin")).toBe(true)
    expect(isSiteAdmin("editor")).toBe(false)
    expect(isSiteAdmin("contributor")).toBe(false)
    expect(isSiteAdmin(undefined)).toBe(false)
  })
})

describe("canEditContent", () => {
  it("allows admins and editors, case-insensitively", () => {
    expect(canEditContent("admin")).toBe(true)
    expect(canEditContent("editor")).toBe(true)
    expect(canEditContent("Editor")).toBe(true)
  })

  it("denies contributors and missing roles", () => {
    expect(canEditContent("contributor")).toBe(false)
    expect(canEditContent("")).toBe(false)
    expect(canEditContent(null)).toBe(false)
    expect(canEditContent(undefined)).toBe(false)
  })
})
