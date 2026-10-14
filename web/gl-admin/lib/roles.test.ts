import { describe, expect, it } from "vitest"
import { canEditContent } from "./roles"

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
