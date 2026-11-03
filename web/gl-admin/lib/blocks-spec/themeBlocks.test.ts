import { describe, it, expect } from "vitest"
import vectors from "./themeBlockVectors.json"
import { validateBlockDoc, type BlockDocV1 } from "./index"
import {
  attrProblem,
  THEME_BLOCK_TYPE,
  themeBlockAttrs,
  themeBlockIssues,
  themeBlockManifest,
  themeBlockSpecProblem,
  type ThemeBlockSpec,
} from "./themeBlocks"

// Theme block specs (#376). The vectors are shared with the API's Go sanitizer
// (api/theme_blocks_test.go): the collab server must refuse exactly what the API would,
// or a store the server sends could be refused with a 400.

const spec = vectors.spec as ThemeBlockSpec

describe("theme block validation (shared vectors with the API)", () => {
  for (const vector of vectors.cases) {
    it(vector.name, () => {
      expect(themeBlockIssues(spec, vector.block).length === 0).toBe(vector.valid)
    })
  }

  it("validateBlockDoc checks an installed theme block against its spec, and leaves others to the catch-all", () => {
    const doc = (block: Record<string, unknown>): BlockDocV1 =>
      ({ doc_version: 1, blocks_order: ["blk-card-00001"], blocks: { "blk-card-00001": { id: "blk-card-00001", type: spec.type, ...block } } }) as unknown as BlockDocV1
    const themeBlocks = (type: string) => (type === spec.type ? spec : undefined)
    expect(() => validateBlockDoc(doc({ version: 1, attrs: { tone: "shouty" } }), { themeBlocks })).toThrow(/tone must be one of/)
    expect(() => validateBlockDoc(doc({ version: 2, attrs: { tone: "loud" } }), { themeBlocks })).not.toThrow()
    // Not installed: any positive version and any attrs, so a removed theme's blocks still store.
    expect(() => validateBlockDoc(doc({ version: 7, attrs: { tone: "shouty" } }), { themeBlocks: () => undefined })).not.toThrow()
    expect(() => validateBlockDoc(doc({ version: 0, attrs: {} }), { themeBlocks: () => undefined })).toThrow()
  })
})

describe("theme block specs", () => {
  it("types are namespaced theme:<theme>/<block> and can't be a core type", () => {
    // The theme part is the directory name, whatever its case.
    for (const good of ["theme:example/alert", "theme:my_theme/card", "theme:Magazine2/pull-quote"]) {
      expect(THEME_BLOCK_TYPE.test(good), good).toBe(true)
    }
    for (const bad of ["alert", "paragraph", "theme:/alert", "theme:-x/alert", "theme:example/Alert", "theme:example/a/b", "theme:example", "theme:ex ample/a"]) {
      expect(THEME_BLOCK_TYPE.test(bad), bad).toBe(false)
    }
  })

  it("refuses reserved or unusable attr names and invalid defaults", () => {
    const base = { type: "theme:x/y", version: 1 }
    expect(themeBlockSpecProblem({ ...base, attrs: { variant: { type: "string", default: "a" } } })).toBeNull()
    for (const name of ["pm", "text", "data-block-id", "onClick", "onload", "my-attr", "1st"]) {
      expect(themeBlockSpecProblem({ ...base, attrs: { [name]: { type: "string", default: "" } } }), name).not.toBeNull()
    }
    expect(themeBlockSpecProblem({ ...base, attrs: { v: { type: "string", enum: ["a"], default: "b" } } })).not.toBeNull()
    expect(themeBlockSpecProblem({ ...base, version: 0, attrs: {} })).not.toBeNull()
    expect(themeBlockSpecProblem({ ...base, attrs: { v: { type: "object", default: {} } as any } })).not.toBeNull()
  })

  it("themeBlockAttrs gives every declared attr, defaulting missing, null and invalid values", () => {
    expect(themeBlockAttrs(spec, { tone: "loud", label: null, size: 9, other: "x" })).toEqual({
      tone: "loud",
      label: "",
      size: 1,
      ratio: 0.5,
      open: false,
    })
    expect(attrProblem(spec.attrs.label, "abcde")).toBeNull()
  })

  it("the manifest is the specs only, with sorted keys", () => {
    const manifest = themeBlockManifest([spec])
    expect(Object.keys(manifest.blocks)).toEqual([spec.type])
    expect(Object.keys(manifest.blocks[spec.type].attrs)).toEqual(["label", "open", "ratio", "size", "tone"])
    expect(Object.keys(manifest.blocks[spec.type].attrs.tone)).toEqual(["default", "enum", "type"])
  })
})
