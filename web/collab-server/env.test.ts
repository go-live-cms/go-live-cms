import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readEnv, readSecretEnv } from "./env"

describe("readEnv", () => {
  it("trims, and is empty when unset", () => {
    expect(readEnv({ A: "  x \n" }, "A")).toBe("x")
    expect(readEnv({}, "A")).toBe("")
  })
})

describe("readSecretEnv (#158)", () => {
  it("reads the plain variable without NAME_FILE", () => {
    expect(readSecretEnv({ ROLE_LOOKUP_SECRET: " s " }, "ROLE_LOOKUP_SECRET")).toBe("s")
    expect(readSecretEnv({}, "ROLE_LOOKUP_SECRET")).toBe("")
  })

  it("reads NAME_FILE, trimming the trailing newline", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "collab-env-"))
    try {
      const file = path.join(dir, "secret")
      writeFileSync(file, "from-file\n")
      expect(readSecretEnv({ ROLE_LOOKUP_SECRET_FILE: file }, "ROLE_LOOKUP_SECRET")).toBe("from-file")
      // An empty plain variable next to it (compose's `X: ""`) is not a conflict.
      expect(readSecretEnv({ ROLE_LOOKUP_SECRET: "", ROLE_LOOKUP_SECRET_FILE: file }, "ROLE_LOOKUP_SECRET")).toBe("from-file")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses both, and names the variables and path but never the contents", () => {
    expect(() => readSecretEnv({ A: "x", A_FILE: "/run/secrets/a" }, "A", () => "secret-value")).toThrow(/both A and A_FILE/)
    let message = ""
    try {
      readSecretEnv({ A_FILE: "/nope/a" }, "A", () => {
        throw new Error("ENOENT")
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("A_FILE")
    expect(message).toContain("/nope/a")
  })
})
