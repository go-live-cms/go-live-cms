import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { PASSWORD_MIN, passwordRule } from "./passwordRules"

// The API's request bindings, next to web/ in the repo. The web container only
// mounts web/, so there the check is skipped; CI runs it from a full checkout.
const API_DIR = path.resolve(__dirname, "../../../api")
const BINDINGS = ["account_bindings.go", "users_bindings.go"].map((f) => path.join(API_DIR, f))

describe("PASSWORD_MIN", () => {
  it.skipIf(!BINDINGS.every((f) => existsSync(f)))("is the API's min= on every new-password binding", () => {
    const mins = BINDINGS.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/Password\s+string\s+`json:"password"\s+binding:"[^"]*\bmin=(\d+)/g)].map((m) => Number(m[1]))
    )
    // Reset, accept invite, create user, update user.
    expect(mins.length).toBeGreaterThanOrEqual(4)
    expect(new Set(mins)).toEqual(new Set([PASSWORD_MIN]))
  })
})

describe("passwordRule", () => {
  it("states the minimum, with the count while short", () => {
    expect(passwordRule("")).toEqual({ met: false, text: `At least ${PASSWORD_MIN} characters` })
    expect(passwordRule("ab")).toEqual({ met: false, text: `At least ${PASSWORD_MIN} characters (2 so far)` })
    expect(passwordRule("x".repeat(PASSWORD_MIN))).toEqual({ met: true, text: `At least ${PASSWORD_MIN} characters` })
  })

  it("counts characters the way the API does (code points)", () => {
    // Six emoji are twelve UTF-16 units but six runes to Go's validator.
    expect(passwordRule("😀".repeat(PASSWORD_MIN - 1)).met).toBe(false)
    expect(passwordRule("😀".repeat(PASSWORD_MIN)).met).toBe(true)
  })
})
