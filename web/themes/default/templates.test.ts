// The default theme's block templates and parts (#498, design theme-builder.md 5.7): every route
// kind of design 3.2 has one (never the 500 page, never `front-page`, which would outrank a page
// set as the front page), each passes its kind's rules as the API's scan and the Site editor check
// them, and the API's starters are these files (api/sitedesign/starters, TestStartersAreTheDefaultThemes).
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { blocksInReadingOrder, validateBlockDoc, type BlockDocKind } from "@gl-admin/lib/blocks-spec"

const here = dirname(fileURLToPath(import.meta.url))
const read = (dir: "templates" | "parts") =>
  readdirSync(join(here, dir))
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ slug: name.replace(/\.json$/, ""), file: JSON.parse(readFileSync(join(here, dir, name), "utf8")) }))

const templates = read("templates")
const parts = read("parts")

describe("the default theme's block templates (#498)", () => {
  it("one per route kind and post or page layout variant, and the header and footer", () => {
    expect(templates.map((t) => t.slug).sort()).toEqual(["404", "archive", "author", "home", "page", "page-fullwidth", "search", "single", "single-sidebar", "single-wide", "taxonomy"])
    expect(parts.map((p) => p.slug).sort()).toEqual(["footer", "header"])
  })

  it.each([...templates.map((t) => ["template", t] as const), ...parts.map((p) => ["part", p] as const)])("%s %s passes its kind's rules", (kind, { file }) => {
    expect(Object.keys(file).sort()).toEqual(["doc", "title"])
    expect(file.title.trim()).not.toBe("")
    expect(() => validateBlockDoc(file.doc, { kind: kind as BlockDocKind })).not.toThrow()
  })

  it("every template places the header and the footer, around one post_content where it shows a post", () => {
    for (const { slug, file } of templates) {
      const order: string[] = file.doc.blocks_order
      expect(file.doc.blocks[order[0]], slug).toMatchObject({ type: "template_part", attrs: { slug: "header" } })
      expect(file.doc.blocks[order[order.length - 1]], slug).toMatchObject({ type: "template_part", attrs: { slug: "footer" } })
      const contents = blocksInReadingOrder(file.doc).filter((id) => file.doc.blocks[id].type === "post_content")
      expect(contents.length, slug).toBe(/^(single|page)/.test(slug) ? 1 : 0)
    }
  })

  it("block ids are unique across the theme's files, so a page never repeats one", () => {
    const ids = [...templates, ...parts].flatMap(({ file }) => Object.keys(file.doc.blocks))
    expect(new Set(ids).size).toBe(ids.length)
  })
})
