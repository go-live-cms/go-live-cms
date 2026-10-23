// load.ts + store.ts on a plain Y.Doc, without Hocuspocus: seed vs restore, epochs,
// dropped blocks, validation (#214 part 2) and the empty-doc guard.
import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import type { BlockDocV1 } from "../gl-admin/lib/blocks-spec"
import { getCoreSchema } from "../gl-admin/lib/collaboration/schema"
import { EDITOR_FRAGMENT } from "../gl-admin/lib/collaboration/fragmentBridge"
import { canonical, ids, richDoc } from "../gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { createInternalApi, normalizeBlockDoc, type CollabRecord } from "./api"
import { loadIntoDoc, readMeta, usableState } from "./load"
import { prepareStore } from "./store"
import { appendParagraph, paragraphDoc, paragraphs } from "./testkit"

const schema = getCoreSchema()
let epochs = 0
const newEpoch = () => `epoch-${++epochs}`

const record = (overrides: Partial<CollabRecord> = {}): CollabRecord => ({
  block_doc: canonical(paragraphDoc("one", "two")),
  block_revision: 3,
  ydoc_state: null,
  epoch: null,
  ...overrides,
})

const stateOf = (doc: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")

/** A doc loaded from `rec` and stored once: what the API would hold afterwards. */
function storedRecord(rec: CollabRecord): CollabRecord {
  const doc = new Y.Doc()
  loadIntoDoc(doc, rec, schema, newEpoch)
  return { ...rec, ydoc_state: stateOf(doc), epoch: readMeta(doc).epoch }
}

function docWithBadBlocks(): BlockDocV1 {
  const doc = canonical(richDoc())
  const badCode = "blk-badcode-001"
  return {
    ...doc,
    blocks_order: [ids.intro, badCode, ...doc.blocks_order.slice(1)],
    blocks: { ...doc.blocks, [badCode]: { id: badCode, type: "code_block", version: 1, attrs: { code: "" } } as BlockDocV1["blocks"][string] },
  }
}

describe("load", () => {
  it("seeds from block_doc when there is no stored state, with a new epoch", () => {
    const doc = new Y.Doc()
    const outcome = loadIntoDoc(doc, record(), schema, newEpoch)
    expect(outcome).toMatchObject({ kind: "seeded", reason: "no-state", dropped: 0 })
    expect(paragraphs(doc)).toEqual(["one", "two"])
    expect(readMeta(doc).epoch).toBe(outcome.epoch)
  })

  it("applies stored state at the current revision as is (no seed, so no duplication)", () => {
    const stored = storedRecord(record())
    const doc = new Y.Doc()
    const outcome = loadIntoDoc(doc, stored, schema, newEpoch)
    expect(outcome).toEqual({ kind: "restored", epoch: stored.epoch })
    expect(paragraphs(doc)).toEqual(["one", "two"])
  })

  it("reseeds with a NEW epoch when block_doc was written around the server (revision mismatch)", () => {
    const stored = storedRecord(record())
    expect(usableState({ ...stored, ydoc_block_revision: 4 })).toBe(false)
    const doc = new Y.Doc()
    const outcome = loadIntoDoc(doc, { ...stored, ydoc_block_revision: 2, block_doc: canonical(paragraphDoc("rolled back")) }, schema, newEpoch)
    expect(outcome).toMatchObject({ kind: "seeded", reason: "revision-mismatch" })
    expect(outcome.epoch).not.toBe(stored.epoch)
    expect(paragraphs(doc)).toEqual(["rolled back"])
  })

  it("keeps what seeding dropped in meta.dropped, across a restart", () => {
    const doc = new Y.Doc()
    const outcome = loadIntoDoc(doc, record({ block_doc: docWithBadBlocks() }), schema, newEpoch)
    expect(outcome).toMatchObject({ kind: "seeded", dropped: 1 })
    const restarted = new Y.Doc()
    Y.applyUpdate(restarted, Y.encodeStateAsUpdate(doc))
    expect(readMeta(restarted).dropped?.entries).toEqual([{ id: "blk-badcode-001", parentId: null, afterId: ids.intro }])
  })

  it("seeds nothing for a post without content, and still issues an epoch", () => {
    const doc = new Y.Doc()
    loadIntoDoc(doc, record({ block_doc: null }), schema, newEpoch)
    expect(doc.getXmlFragment(EDITOR_FRAGMENT).length).toBe(0)
    expect(readMeta(doc).epoch).toMatch(/^epoch-/)
  })

  it("seeds an empty doc for a post whose block_doc is {} instead of throwing (#304)", () => {
    // Posts that never had blocks store `{}` (no blocks / blocks_order). load must not
    // throw on it even without api.ts's normalization (FakeCollabApi bypasses that).
    const doc = new Y.Doc()
    const outcome = loadIntoDoc(doc, record({ block_doc: {} as unknown as BlockDocV1 }), schema, newEpoch)
    expect(outcome).toMatchObject({ kind: "seeded", reason: "no-state", dropped: 0 })
    expect(doc.getXmlFragment(EDITOR_FRAGMENT).length).toBe(0)
    expect(readMeta(doc).epoch).toBe(outcome.epoch)
  })

  it("empties the old client's blocks/blocks_order mirror", () => {
    const old = new Y.Doc()
    old.getMap("blocks").set("x", new Y.Map())
    old.getArray("blocks_order").push(["x"])
    old.getMap("meta").set("restore_id", "r1")
    const doc = new Y.Doc()
    loadIntoDoc(doc, { ...record(), ydoc_state: stateOf(old), epoch: "epoch-old" }, schema, newEpoch)
    expect(doc.getMap("blocks").size).toBe(0)
    expect(doc.getArray("blocks_order").length).toBe(0)
    expect(doc.getMap("meta").get("restore_id")).toBe("r1")
  })

  it("throws on stored state that can't be decoded, instead of reseeding over it", () => {
    expect(() => loadIntoDoc(new Y.Doc(), record({ ydoc_state: Buffer.from([255, 255, 255]).toString("base64"), epoch: "e" }), schema)).toThrow()
  })
})

describe("normalizeBlockDoc (#304)", () => {
  it("passes a Block Spec doc through unchanged", () => {
    const doc = canonical(paragraphDoc("one"))
    expect(normalizeBlockDoc(doc)).toBe(doc)
  })

  it("getCollab returns block_doc null when the API sends {}", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ block_doc: {}, block_revision: 1 }), { status: 200 })) as unknown as typeof fetch
    const api = createInternalApi({ apiUrl: "http://api.test", secret: "s", fetchImpl })
    const rec = await api.getCollab("1410")
    expect(rec).toMatchObject({ block_doc: null, block_revision: 1 })
  })

  it("maps anything that isn't shaped like a Block Spec doc to null", () => {
    for (const raw of [{}, null, undefined, [], "x", 1, { blocks: {} }, { blocks_order: [] }, { blocks: [], blocks_order: [] }, { blocks: {}, blocks_order: "a" }]) {
      expect(normalizeBlockDoc(raw)).toBeNull()
    }
  })
})

describe("store", () => {
  const loaded = (rec: CollabRecord = record()) => {
    const doc = new Y.Doc()
    loadIntoDoc(doc, rec, schema, newEpoch)
    return doc
  }

  it("derives a validated block_doc from the fragment and sends state + epoch", () => {
    const doc = loaded()
    appendParagraph(doc, "three", "blk-para-000003")
    const { body, decision } = prepareStore(doc, schema, { previous: record().block_doc, clientEdited: true, lastEditorId: "7" })
    expect(decision.write).toBe(true)
    expect(body.block_doc?.blocks_order).toEqual(["blk-para-000001", "blk-para-000002", "blk-para-000003"])
    expect(body.epoch).toBe(readMeta(doc).epoch)
    expect(body.last_editor_id).toBe(7)
    const roundTrip = new Y.Doc()
    Y.applyUpdate(roundTrip, Buffer.from(body.state, "base64"))
    expect(paragraphs(roundTrip)).toEqual(["one", "two", "three"])
  })

  it("writes a real block_doc on the first edit of a post that had block_doc {} (#304)", () => {
    // What the server sees for such a post: api.ts normalizes `{}` to null.
    const previous = normalizeBlockDoc({})
    expect(previous).toBeNull()
    const doc = loaded(record({ block_doc: previous }))
    appendParagraph(doc, "first words", "blk-para-000001")
    const { body, decision } = prepareStore(doc, schema, { previous, clientEdited: true, lastEditorId: "1" })
    expect(decision.write).toBe(true)
    expect(body.block_doc?.blocks_order).toEqual(["blk-para-000001"])
  })

  it("replaces block_doc {} with a well-formed empty doc when an untouched post is stored (#304)", () => {
    const previous = normalizeBlockDoc({})
    const doc = loaded(record({ block_doc: previous }))
    const { decision } = prepareStore(doc, schema, { previous, clientEdited: false, lastEditorId: null })
    expect(decision.write).toBe(true)
    expect(decision.write && decision.blockDoc.blocks_order).toEqual([])
  })

  it("doesn't rewrite block_doc when nothing changed (no revision churn)", () => {
    const rec = record()
    const doc = loaded(rec)
    const { body, decision } = prepareStore(doc, schema, { previous: rec.block_doc, clientEdited: false, lastEditorId: null })
    expect(decision).toEqual({ write: false, reason: "unchanged" })
    expect(body.block_doc).toBeUndefined()
  })

  it("treats a previous doc with reordered keys (Postgres jsonb) as unchanged", () => {
    const rec = record()
    const doc = loaded(rec)
    const reorder = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reorder)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)]))
          : value
    const fromJsonb = reorder(rec.block_doc) as BlockDocV1
    expect(JSON.stringify(fromJsonb)).not.toBe(JSON.stringify(rec.block_doc))
    const { decision } = prepareStore(doc, schema, { previous: fromJsonb, clientEdited: false, lastEditorId: null })
    expect(decision).toEqual({ write: false, reason: "unchanged" })
  })

  it("puts the blocks seeding dropped back into block_doc", () => {
    const source = docWithBadBlocks()
    const doc = loaded(record({ block_doc: source }))
    appendParagraph(doc, "new", "blk-para-new0001")
    const { decision } = prepareStore(doc, schema, { previous: source, clientEdited: true, lastEditorId: "7" })
    if (!decision.write) throw new Error(`expected a write, got ${decision.reason}`)
    expect(decision.blockDoc.blocks_order.slice(0, 2)).toEqual([ids.intro, "blk-badcode-001"])
    expect(decision.blockDoc.blocks["blk-badcode-001"]).toEqual(source.blocks["blk-badcode-001"])
    expect(decision.blockDoc.blocks_order.at(-1)).toBe("blk-para-new0001")
  })

  it("an invalid derived doc stores the Yjs state only and keeps the last valid block_doc (#214)", () => {
    const doc = loaded()
    // A heading level the Zod schema refuses, written by a buggy or hostile peer.
    doc.transact(() => {
      const heading = new Y.XmlElement("heading")
      doc.getXmlFragment(EDITOR_FRAGMENT).insert(0, [heading])
      heading.setAttribute("data-block-id", "blk-badheading1")
      heading.setAttribute("level", 9 as unknown as string)
      heading.insert(0, [new Y.XmlText("too deep")])
    })
    const { body, decision } = prepareStore(doc, schema, { previous: record().block_doc, clientEdited: true, lastEditorId: "7" })
    expect(decision).toMatchObject({ write: false, reason: "invalid" })
    expect(body.block_doc).toBeUndefined()
    expect(body.state.length).toBeGreaterThan(0)
  })

  it("never writes an empty block_doc nobody asked for (failed seed)", () => {
    const rec = record({ block_doc: { doc_version: 1, blocks_order: [ids.intro], blocks: {} } as BlockDocV1 })
    const doc = loaded(rec)
    expect(doc.getXmlFragment(EDITOR_FRAGMENT).length).toBe(0)
    const previous = canonical(paragraphDoc("keep me"))
    const { decision } = prepareStore(doc, schema, { previous, clientEdited: false, lastEditorId: null })
    expect(decision).toEqual({ write: false, reason: "empty-without-edit" })
  })

  it("writes an empty block_doc when a client deleted everything", () => {
    const rec = record()
    const doc = loaded(rec)
    const fragment = doc.getXmlFragment(EDITOR_FRAGMENT)
    fragment.delete(0, fragment.length)
    const { decision } = prepareStore(doc, schema, { previous: rec.block_doc, clientEdited: true, lastEditorId: "7" })
    expect(decision.write && decision.blockDoc.blocks_order).toEqual([])
  })

  it("stamps missing block ids into the live doc once, so ids don't churn between stores", () => {
    const doc = loaded()
    doc.transact(() => {
      const p = new Y.XmlElement("paragraph")
      doc.getXmlFragment(EDITOR_FRAGMENT).insert(2, [p])
      p.insert(0, [new Y.XmlText("no id")])
    })
    const first = prepareStore(doc, schema, { previous: record().block_doc, clientEdited: true, lastEditorId: "7" })
    expect(first.stamped).toBe(1)
    if (!first.decision.write) throw new Error("expected a write")
    const second = prepareStore(doc, schema, { previous: first.decision.blockDoc, clientEdited: true, lastEditorId: "7" })
    expect(second.stamped).toBe(0)
    expect(second.decision).toEqual({ write: false, reason: "unchanged" })
  })
})
