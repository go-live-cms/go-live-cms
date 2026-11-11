import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import vectors from "./pluginManifestVectors.json"
import { PLUGIN_API, pluginApiCompatible, validatePluginManifest } from "./manifest"

type VectorCase = {
  name: string
  valid: boolean
  field?: string
  dir?: string
  set?: Record<string, unknown>
  replace?: unknown
}

// The case's manifest: `replace`, or the base with `set`'s top-level keys merged over it
// (null deletes). The Go side (TestPluginManifestVectors) builds it the same way.
function caseManifest(tc: VectorCase): unknown {
  if (tc.replace !== undefined) return tc.replace
  const manifest: Record<string, unknown> = structuredClone(vectors.base)
  for (const [key, value] of Object.entries(tc.set ?? {})) {
    if (value === null) delete manifest[key]
    else manifest[key] = value
  }
  return manifest
}

describe("plugin manifest vectors (shared with api/plugins_manifest.go)", () => {
  const cases = vectors.cases as VectorCase[]

  it("has cases both ways", () => {
    expect(cases.some((tc) => tc.valid)).toBe(true)
    expect(cases.some((tc) => !tc.valid)).toBe(true)
  })

  for (const tc of cases) {
    it(tc.name, () => {
      const result = validatePluginManifest(caseManifest(tc), tc.dir ?? vectors.base.id)
      if (tc.valid) {
        expect(result).toEqual(expect.objectContaining({ ok: true }))
      } else {
        expect(result).toEqual(expect.objectContaining({ ok: false, field: tc.field }))
      }
    })
  }
})

describe("plugin_api range", () => {
  it("matches the Go constants", () => {
    const go = fs.readFileSync(path.resolve("../api/plugins_manifest.go"), "utf8")
    expect(go).toMatch(new RegExp(`PluginAPIMin\\s*=\\s*${PLUGIN_API.min}\\b`))
    expect(go).toMatch(new RegExp(`PluginAPIMax\\s*=\\s*${PLUGIN_API.max}\\b`))
  })

  it("is compatible inside the range only", () => {
    expect(pluginApiCompatible(PLUGIN_API.min)).toBe(true)
    expect(pluginApiCompatible(PLUGIN_API.max)).toBe(true)
    expect(pluginApiCompatible(PLUGIN_API.max + 1)).toBe(false)
    expect(pluginApiCompatible(0)).toBe(false)
  })
})

// A plugin in the repository that fails the validator fails CI (the Go suite checks the
// same directory with TestRepositoryPluginsValidate).
describe("plugins in the repository", () => {
  const root = path.resolve("plugins")
  const dirs = fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
    : []

  it("has the plugins directory", () => {
    expect(fs.existsSync(root)).toBe(true)
  })

  for (const dir of dirs) {
    it(`${dir}/plugin.json validates`, () => {
      const file = path.join(root, dir, "plugin.json")
      expect(fs.existsSync(file), `${dir} has no plugin.json`).toBe(true)
      const result = validatePluginManifest(JSON.parse(fs.readFileSync(file, "utf8")), dir)
      expect(result).toEqual(expect.objectContaining({ ok: true }))
    })
  }
})
