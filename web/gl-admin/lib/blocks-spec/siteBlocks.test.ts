import { describe, expect, it } from "vitest"
import vectors from "./siteBlockVectors.json"
import {
  BLOCK_NODE_NAMES,
  dedupeBlockRefs,
  isFlowType,
  isSiteContainerType,
  isStandaloneFlowType,
  SITE_CONTAINER_TYPES,
  SITE_FLOW_BLOCK_TYPES,
  normalizeSiteBlockAttrs,
  SITE_BLOCK_CONTEXTS,
  SITE_BLOCK_NODE_NAMES,
  SITE_BLOCK_TYPES,
  siteBlockKindIssues,
  siteBlockNodeAttrs,
  validateBlock,
  validateBlockDoc,
  type BlockDocKind,
  type SiteBlockType,
} from "./index"

// Site blocks I (#488). The vectors are the API's too (api/post_blocks_site_test.go), so the
// editor's bridge, the collab store and the API keep and refuse the same things.

describe("siteBlockVectors.json attrs (shared with the API)", () => {
  for (const vector of vectors.attrs) {
    it(vector.name, () => {
      const type = vector.type as SiteBlockType
      const out = normalizeSiteBlockAttrs(type, vector.input)
      expect(out).toEqual(vector.expected)
      // What it keeps is what the store's validator accepts, and normalizing is idempotent.
      // A container (#489) holds its children by id; how many is the nesting table's.
      const children = isSiteContainerType(type) ? { children: [] } : {}
      expect(() => validateBlock({ id: "block-0001", type, version: 1, attrs: out, ...children })).not.toThrow()
      expect(normalizeSiteBlockAttrs(type, out)).toEqual(out)
      // The node's attrs (defaults filled in) come back to the same stored attrs.
      expect(normalizeSiteBlockAttrs(type, siteBlockNodeAttrs(type, out))).toEqual(out)
    })
  }
})

describe("siteBlockVectors.json kinds (shared with the API)", () => {
  for (const vector of vectors.kinds) {
    it(`${vector.name} (${vector.kind})`, () => {
      const run = () => validateBlockDoc(dedupeBlockRefs(vector.doc), { kind: vector.kind as BlockDocKind })
      if (vector.valid) expect(run).not.toThrow()
      else expect(run).toThrow()
    })
  }
})

describe("site blocks in the Block Spec", () => {
  it("are flow atoms that never sit in another block's content", () => {
    for (const type of SITE_FLOW_BLOCK_TYPES) {
      expect(isFlowType(type)).toBe(true)
      expect(isStandaloneFlowType(type)).toBe(true)
      expect(BLOCK_NODE_NAMES[type]).toBe(SITE_BLOCK_NODE_NAMES[type])
    }
  })

  it("the query loop (#489): three containers and a pager that only live where the table puts them", () => {
    for (const type of [...SITE_CONTAINER_TYPES, "query_pagination"] as const) {
      expect(isFlowType(type), type).toBe(false)
      expect(BLOCK_NODE_NAMES[type]).toBe(SITE_BLOCK_NODE_NAMES[type])
    }
    // #488's six, #489's fourteen, #497's four, #498's six.
    expect(SITE_BLOCK_TYPES).toHaveLength(30)
  })

  it("validateBlockDoc defaults to a post, where nothing about a site block is an error", () => {
    const doc = vectors.kinds.find((vector) => vector.kind === "post" && vector.valid)!.doc
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(siteBlockKindIssues(doc, "post")).toEqual([])
  })

  it("refuses a kind it doesn't know rather than checking nothing", () => {
    expect(() => validateBlockDoc({ doc_version: 1, blocks_order: [], blocks: {} }, { kind: "page" as BlockDocKind })).toThrow(/kind/)
  })

  it("names the template part a part can't hold", () => {
    const doc = vectors.kinds.find((vector) => vector.name === "a part can't hold a template part")!.doc
    expect(siteBlockKindIssues(doc, "part")).toEqual([{ path: ["blocks", "part-00001"], message: "a template_part can't be in a part" }])
    expect(siteBlockKindIssues(doc, "template")).toEqual([])
  })

  it("the store's validator refuses what the bridge never writes", () => {
    const bad: [SiteBlockType, Record<string, unknown>][] = [
      ["site_title", { level: 0 }],
      ["site_title", { link: true }],
      ["site_tagline", { text: "x" }],
      ["site_logo", { width: 48 }],
      ["site_logo", { width: 700 }],
      ["navigation", { location: "primary", menuId: 2 }],
      ["navigation", { layout: "row" }],
      ["search", { label: " padded " }],
      ["search", { button: "x".repeat(41) }],
      ["template_part", { slug: "Header" }],
    ]
    for (const [type, attrs] of bad) {
      expect(() => validateBlock({ id: "block-0001", type, version: 1, attrs }), `${type} ${JSON.stringify(attrs)}`).toThrow()
    }
  })

  it("offers every site block in templates, and the template part nowhere else (design 4.2, 4.4)", () => {
    for (const type of SITE_BLOCK_TYPES) {
      expect(SITE_BLOCK_CONTEXTS[type]).not.toContain("post")
      expect(SITE_BLOCK_CONTEXTS[type]).toContain("template")
    }
    expect(SITE_BLOCK_CONTEXTS.template_part).toEqual(["template"])
  })
})
