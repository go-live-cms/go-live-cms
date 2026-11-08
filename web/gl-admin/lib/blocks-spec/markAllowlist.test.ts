// @vitest-environment node
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import { CAPTION_MARKS } from "./index"

// #418: the API's sanitizer keeps only the mark types on its allowlist
// (`allowedMarkTypes` in api/post_blocks_sanitize.go) and drops every other one. A mark
// the editor can write but the API doesn't list would be stripped from every stored
// post, and a listed mark the editor no longer has would pass marks no editor can build
// (rule 10). So the list must be exactly the editor schema's marks. The editor's schema
// equals this one (schema.test.ts), core and installed theme blocks alike.
//
// Read from the Go source, next to web/ in the repo; skipped where only web/ is mounted.
const SANITIZER = path.resolve(__dirname, "../../../../api/post_blocks_sanitize.go")

function goMarkAllowlist(): Map<string, boolean> {
  const go = readFileSync(SANITIZER, "utf8")
  const body = go.match(/var allowedMarkTypes = map\[string\]bool\{([\s\S]*?)\n\}/)?.[1]
  if (!body) throw new Error("allowedMarkTypes not found in post_blocks_sanitize.go")
  const entries = [...body.matchAll(/^\s*"([^"]+)":\s*(true|false),/gm)]
  return new Map(entries.map(([, name, keepsAttrs]) => [name, keepsAttrs === "true"]))
}

describe.skipIf(!existsSync(SANITIZER))("the API's mark allowlist (#418)", () => {
  const schema = getInstalledCollabSchema()
  let allowlist: Map<string, boolean>
  beforeAll(() => {
    allowlist = goMarkAllowlist()
  })

  it("lists every mark of the editor's schema", () => {
    const missing = Object.keys(schema.marks).filter((name) => !allowlist.has(name))
    expect(missing, "add these to allowedMarkTypes in api/post_blocks_sanitize.go").toEqual([])
  })

  it("lists nothing the editor's schema doesn't have", () => {
    const extra = [...allowlist.keys()].filter((name) => !schema.marks[name])
    expect(extra, "the editor can't build these: remove them from allowedMarkTypes").toEqual([])
  })

  it("keeps attrs exactly for the marks that have them in the schema", () => {
    for (const [name, type] of Object.entries(schema.marks)) {
      const hasAttrs = Object.keys(type.spec.attrs ?? {}).length > 0
      expect(allowlist.get(name), name).toBe(hasAttrs)
    }
    // The highlight is one theme colour: no `color` attr to keep.
    expect(schema.marks.highlight.spec.attrs ?? {}).toEqual({})
  })

  it("includes the three #418 marks, and the caption marks", () => {
    for (const name of ["highlight", "superscript", "subscript", ...CAPTION_MARKS]) expect(allowlist.has(name), name).toBe(true)
  })
})
