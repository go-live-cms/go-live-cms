import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { PASSWORD_DETAILS_RULE, PASSWORD_MIN, passwordHint, passwordMatchesDetails, passwordRule } from "./passwordRules"

// The API's password rules, next to web/ in the repo. The web container only
// mounts web/, so there the check is skipped; CI runs it from a full checkout.
const API_DIR = path.resolve(__dirname, "../../../api")
const PASSWORD_UTILS = path.join(API_DIR, "password_utils.go")
const BINDINGS = ["account_bindings.go", "users_bindings.go"].map((f) => path.join(API_DIR, f))
const API_FILES = [PASSWORD_UTILS, ...BINDINGS]

describe("PASSWORD_MIN", () => {
  it("is 12 (#329)", () => {
    expect(PASSWORD_MIN).toBe(12)
  })

  it.skipIf(!API_FILES.every((f) => existsSync(f)))("is the API's MinPasswordLength, which every new-password binding applies", () => {
    const go = readFileSync(PASSWORD_UTILS, "utf8")
    expect(Number(go.match(/const MinPasswordLength = (\d+)/)?.[1])).toBe(PASSWORD_MIN)

    const tags = BINDINGS.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/Password\s+string\s+`json:"password"\s+binding:"([^"]*)"/g)].map((m) => m[1])
    )
    // Reset, accept invite, create user, update user.
    expect(tags.length).toBeGreaterThanOrEqual(4)
    for (const tag of tags) {
      expect(tag.split(",")).toContain("new_password")
      expect(tag).not.toMatch(/\bmin=/)
    }
  })
})

describe("passwordRule", () => {
  it("states the minimum, with the count while short", () => {
    expect(passwordRule("")).toEqual({ met: false, text: "At least 12 characters" })
    expect(passwordRule("ab")).toEqual({ met: false, text: "At least 12 characters (2 so far)" })
    expect(passwordRule("x".repeat(11))).toEqual({ met: false, text: "At least 12 characters (11 so far)" })
    expect(passwordRule("x".repeat(12))).toEqual({ met: true, text: "At least 12 characters" })
  })

  it("counts characters the way the API does (code points)", () => {
    // Eleven emoji are 22 UTF-16 units but eleven runes to Go's validator.
    expect(passwordRule("😀".repeat(PASSWORD_MIN - 1)).met).toBe(false)
    expect(passwordRule("😀".repeat(PASSWORD_MIN)).met).toBe(true)
  })
})

describe("passwordMatchesDetails", () => {
  // The same cases as TestPasswordMatchesDetails in api/password_utils_test.go.
  const details = ["marisol@example.com", "marisolduarte", "Marisol Duarte", ""]

  it("matches a detail ignoring case and surrounding space", () => {
    for (const password of ["marisol@example.com", "MARISOL@EXAMPLE.COM", "MarisolDuarte", "marisol duarte", "  Marisol Duarte  "]) {
      expect(passwordMatchesDetails(password, details), password).toBe(true)
    }
  })

  it("doesn't match anything else, or an empty detail", () => {
    for (const password of ["marisol", "marisolduarte1", "Marisol  Duarte", "", "   "]) {
      expect(passwordMatchesDetails(password, details), password).toBe(false)
    }
    expect(passwordMatchesDetails("", [undefined, null, ""])).toBe(false)
  })

  it("names the rule as the design does", () => {
    expect(PASSWORD_DETAILS_RULE).toBe("Not your email or name")
  })
})

describe("passwordHint (the admin user form's hint)", () => {
  it("states both rules, with the count while short", () => {
    expect(passwordHint("")).toBe("At least 12 characters. Not your email or name.")
    expect(passwordHint("abc")).toBe("At least 12 characters (3 so far). Not your email or name.")
  })
})
