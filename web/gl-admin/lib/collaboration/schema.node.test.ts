// @vitest-environment node
import { describe, it, expect } from "vitest"
import { getCoreSchema } from "./schema"

// The collab server (#206) runs in plain Node, with no DOM. Every other collaboration
// test runs under jsdom (vitest.config.ts), which would hide an extension that touches
// `window`/`document` while its schema is built.
describe("core schema without a DOM (#206)", () => {
  it("builds in plain Node", () => {
    expect(typeof globalThis.document).toBe("undefined")
    const schema = getCoreSchema()
    expect(schema.nodes.heading).toBeDefined()
    expect(schema.marks.link).toBeDefined()
  })
})
