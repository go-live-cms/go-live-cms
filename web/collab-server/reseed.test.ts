// A stored Yjs state holding a block of an extension the build no longer has (#453,
// design docs/design/plugin-system.md 4.4): loadIntoDoc reseeds it once, under a new
// epoch, with that block dropped and kept, and reseeds again when the extension is back,
// which puts the block back in place. Plain Y.Docs, no Hocuspocus (the relay test is
// gl-admin/lib/theme-blocks/uninstalledBlocks.collab.test.ts).
//
// "Removed" = the core schema (no theme blocks); "installed" = the installed collab
// schema, which has the example theme's alert (`theme:example/alert`).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as Y from "yjs"
import type { BlockDocV1 } from "../gl-admin/lib/blocks-spec"
import { pmToBlockDoc } from "../gl-admin/lib/collaboration/blockBridge"
import { getCoreSchema } from "../gl-admin/lib/collaboration/schema"
import { findUnbuildableTypes } from "../gl-admin/lib/collaboration/schemaGuard"
import { EDITOR_FRAGMENT, fragmentToBlockDoc } from "../gl-admin/lib/collaboration/fragmentBridge"
import { getInstalledCollabSchema } from "../gl-admin/lib/theme-blocks/collabSchema"
import type { CollabRecord } from "./api"
import { loadIntoDoc, readMeta, META_MAP } from "./load"
import { prepareStore } from "./store"
import { appendParagraph } from "./testkit"

const installed = getInstalledCollabSchema()
const removed = getCoreSchema()
const ALERT_TYPE = "theme:example/alert"

// Seeding warns for every block it drops; these tests drop on purpose.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

let epochs = 0
const newEpoch = () => `epoch-${++epochs}`
const stateOf = (doc: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")

const ID = {
  intro: "blk-0453-intro-000001",
  alert: "blk-0453-alert-000001",
  group: "blk-0453-group-000001",
  inGroup: "blk-0453-ingroup-00001",
  groupAlert: "blk-0453-galert-000001",
  quote: "blk-0453-quote-000001",
  end: "blk-0453-end-00000001",
}

const text = (value: string) => [{ type: "text", text: value }]
const para = (id: string, value: string) => ({ type: "paragraph", attrs: { "data-block-id": id }, content: text(value) })
const alertNode = (id: string | null, variant: string, value: string) => ({
  type: ALERT_TYPE,
  attrs: { variant, ...(id ? { "data-block-id": id } : {}) },
  content: text(value),
})

/** A post with the alert at the top level, inside a Group and inside a quote, as an installed build stores it. */
function postWithAlerts(): BlockDocV1 {
  const pm = installed.nodeFromJSON({
    type: "doc",
    content: [
      para(ID.intro, "Intro"),
      alertNode(ID.alert, "warning", "Top"),
      { type: "group", attrs: { "data-block-id": ID.group }, content: [para(ID.inGroup, "In group"), alertNode(ID.groupAlert, "error", "Grouped")] },
      { type: "blockquote", attrs: { "data-block-id": ID.quote }, content: [para("x", "Quoted"), alertNode(null, "success", "Nested")] },
      para(ID.end, "End"),
    ],
  })
  pm.check()
  const doc = pmToBlockDoc(pm)
  expect(Object.keys(doc.blocks)).toEqual(expect.arrayContaining(Object.values(ID)))
  return doc
}

/** Loads `record` with `schema` into a fresh doc, then stores it once: the record the API would hold next. */
function loadAndStore(record: CollabRecord, schema: typeof installed, edit?: (doc: Y.Doc) => void) {
  const doc = new Y.Doc()
  const outcome = loadIntoDoc(doc, record, schema, newEpoch)
  edit?.(doc)
  const { body, decision } = prepareStore(doc, schema, { previous: record.block_doc, clientEdited: !!edit, lastEditorId: null })
  const next: CollabRecord = {
    ...record,
    block_doc: decision.write ? decision.blockDoc : record.block_doc,
    ydoc_state: body.state,
    epoch: body.epoch,
  }
  return { doc, outcome, next, decision }
}

/** Every element name in the fragment, at any depth. */
function elementNames(doc: Y.Doc): string[] {
  const names: string[] = []
  const walk = (parent: Y.XmlFragment | Y.XmlElement) =>
    parent.toArray().forEach((child) => {
      if (child instanceof Y.XmlElement) {
        names.push(child.nodeName)
        walk(child)
      }
    })
  walk(doc.getXmlFragment(EDITOR_FRAGMENT))
  return names
}

/** The post as an installed build has stored it: block_doc plus usable Yjs state. */
function storedInstalled(): CollabRecord {
  const blockDoc = postWithAlerts()
  const first = loadAndStore({ block_doc: blockDoc, block_revision: 4, ydoc_state: null, epoch: null }, installed)
  expect(first.outcome).toMatchObject({ kind: "seeded", dropped: 0 })
  expect(elementNames(first.doc).filter((name) => name === ALERT_TYPE)).toHaveLength(3)
  return { ...first.next, block_doc: blockDoc }
}

describe("a stored state with a removed extension's block (#453)", () => {
  it("reseeds once: the rest is editable, the block is kept in meta.dropped at the top level, in a Group and in a quote", () => {
    const record = storedInstalled()

    const { doc, outcome } = loadAndStore(record, removed)
    expect(outcome).toMatchObject({ kind: "seeded", reason: "uninstalled-blocks", dropped: 3 })
    expect(outcome.epoch).not.toBe(record.epoch)
    expect(readMeta(doc).epoch).toBe(outcome.epoch)

    // Nothing the editor (the same schema, rule 10) can't build: it binds, so the post is editable.
    expect(elementNames(doc)).not.toContain(ALERT_TYPE)
    expect(findUnbuildableTypes(doc.getXmlFragment(EDITOR_FRAGMENT), removed)).toBeNull()
    // The group stays with its other block; the quote, whose pm holds the alert, is hidden whole.
    const top = doc.getXmlFragment(EDITOR_FRAGMENT).toArray().map((child) => (child as Y.XmlElement).getAttribute("data-block-id"))
    expect(top).toEqual([ID.intro, ID.group, ID.end])
    const dropped = readMeta(doc).dropped!
    expect(dropped.entries).toEqual([
      { id: ID.alert, parentId: null, afterId: ID.intro },
      { id: ID.groupAlert, parentId: ID.group, afterId: ID.inGroup },
      { id: ID.quote, parentId: null, afterId: ID.group },
    ])
    // Byte for byte as stored, in the installed shape (attrs on the block, not in pm).
    for (const id of [ID.alert, ID.groupAlert, ID.quote]) expect(dropped.blocks[id]).toEqual(record.block_doc!.blocks[id])
    expect(dropped.blocks[ID.alert].attrs).toMatchObject({ variant: "warning", pm: { type: ALERT_TYPE, content: text("Top") } })
  })

  it("stores keep the block, the next load restores (no second reseed), and reinstalling puts it back in place", () => {
    const original = storedInstalled()

    // Removed: the reseed, then an edit, stored.
    const afterRemoval = loadAndStore(original, removed, (doc) => appendParagraph(doc, "Written while removed", "blk-0453-written-0001"))
    expect(afterRemoval.outcome).toMatchObject({ kind: "seeded", reason: "uninstalled-blocks" })
    expect(afterRemoval.decision.write).toBe(true)
    const stored = afterRemoval.next.block_doc!
    for (const id of [ID.alert, ID.groupAlert, ID.quote]) expect(stored.blocks[id]).toEqual(original.block_doc!.blocks[id])
    expect(stored.blocks_order).toEqual([ID.intro, ID.alert, ID.group, ID.quote, ID.end, "blk-0453-written-0001"])
    expect(stored.blocks[ID.group].children).toEqual([ID.inGroup, ID.groupAlert])

    // Reseeded once: the next load with the same build applies the state as is.
    const again = loadAndStore(afterRemoval.next, removed)
    expect(again.outcome).toEqual({ kind: "restored", epoch: afterRemoval.outcome.epoch })
    expect(again.decision).toEqual({ write: false, reason: "unchanged" })

    // Reinstalled: reseeded once more, every alert back where it was, the edit kept.
    const back = loadAndStore(again.next, installed)
    expect(back.outcome).toMatchObject({ kind: "seeded", reason: "uninstalled-blocks", dropped: 0 })
    expect(back.outcome.epoch).not.toBe(afterRemoval.outcome.epoch)
    expect(elementNames(back.doc).filter((name) => name === ALERT_TYPE)).toHaveLength(3)
    expect(back.doc.getMap(META_MAP).has("dropped")).toBe(false)
    const derived = fragmentToBlockDoc(back.doc.getXmlFragment(EDITOR_FRAGMENT), installed)
    expect(derived).toEqual(stored)
    expect((back.doc.getXmlFragment(EDITOR_FRAGMENT).get(1) as Y.XmlElement).getAttribute("variant")).toBe("warning")

    // And once only.
    expect(loadAndStore(back.next, installed).outcome).toMatchObject({ kind: "restored" })
  })

  it("derives from the state, not block_doc (edits a kept-invalid store never wrote)", () => {
    const record = storedInstalled()
    // An edit stored as state only: block_doc is still the one from before it.
    const edited = loadAndStore(record, installed, (doc) => appendParagraph(doc, "Only in the state", "blk-0453-state-00001"))
    const stateOnly = { ...edited.next, block_doc: record.block_doc }

    const { doc, outcome } = loadAndStore(stateOnly, removed)
    expect(outcome).toMatchObject({ kind: "seeded", reason: "uninstalled-blocks" })
    expect(doc.getXmlFragment(EDITOR_FRAGMENT).toJSON()).toContain("Only in the state")
  })

  it("an extension block that block_doc doesn't have yet has its attrs lifted out of pm onto the block", () => {
    const record = storedInstalled()
    const NEW = "blk-0453-newalert-0001"
    const edited = loadAndStore(record, installed, (doc) => {
      doc.transact(() => {
        const element = new Y.XmlElement(ALERT_TYPE)
        element.setAttribute("data-block-id", NEW)
        element.setAttribute("variant", "error")
        element.insert(0, [new Y.XmlText("Fresh")])
        const fragment = doc.getXmlFragment(EDITOR_FRAGMENT)
        fragment.insert(fragment.length, [element])
      })
    })
    const stateOnly = { ...edited.next, block_doc: record.block_doc }

    const { doc } = loadAndStore(stateOnly, removed)
    expect(readMeta(doc).dropped!.blocks[NEW]).toEqual({
      id: NEW,
      type: ALERT_TYPE,
      version: 1,
      attrs: { variant: "error", pm: { type: ALERT_TYPE, content: text("Fresh") }, text: "Fresh" },
    })
    // The installed build reads that shape back as its own.
    const back = loadAndStore({ ...loadAndStore(stateOnly, removed).next }, installed)
    const derived = fragmentToBlockDoc(back.doc.getXmlFragment(EDITOR_FRAGMENT), installed)
    expect(derived.blocks[NEW]).toEqual(readMeta(doc).dropped!.blocks[NEW])
  })

  it("a plugin: block (#452's namespace) is reseeded out the same way", () => {
    const PLUGIN = "plugin:reading-time/estimate"
    const NOTE = "blk-0453-plugin-000001"
    const doc = new Y.Doc()
    doc.transact(() => {
      const fragment = doc.getXmlFragment(EDITOR_FRAGMENT)
      const p = new Y.XmlElement("paragraph")
      p.setAttribute("data-block-id", ID.intro)
      p.insert(0, [new Y.XmlText("Intro")])
      const note = new Y.XmlElement(PLUGIN)
      note.setAttribute("data-block-id", NOTE)
      note.setAttribute("label", "min read")
      fragment.insert(0, [p, note])
      doc.getMap(META_MAP).set("epoch", "epoch-plugin")
    })
    const record: CollabRecord = { block_doc: null, block_revision: 2, ydoc_state: stateOf(doc), epoch: "epoch-plugin" }

    const { doc: loaded, outcome, next } = loadAndStore(record, removed)
    expect(outcome).toMatchObject({ kind: "seeded", reason: "uninstalled-blocks", dropped: 1 })
    expect(elementNames(loaded)).toEqual(["paragraph"])
    expect(readMeta(loaded).dropped!.blocks[NOTE]).toMatchObject({ type: PLUGIN, attrs: { label: "min read", pm: { type: PLUGIN } } })
    expect(next.block_doc!.blocks_order).toEqual([ID.intro, NOTE])
    expect(loadAndStore(next, removed).outcome).toMatchObject({ kind: "restored" })
  })
})

describe("a block dropped for another reason doesn't reseed (#453)", () => {
  it("a core block that can't be built (an empty code block)", () => {
    const BAD = "blk-0453-badcode-0001"
    const blockDoc: BlockDocV1 = {
      ...postWithAlerts(),
    }
    blockDoc.blocks_order = [BAD, ...blockDoc.blocks_order]
    blockDoc.blocks[BAD] = { id: BAD, type: "code_block", version: 1, attrs: { code: "" } } as BlockDocV1["blocks"][string]
    const first = loadAndStore({ block_doc: blockDoc, block_revision: 4, ydoc_state: null, epoch: null }, installed)
    expect(first.outcome).toMatchObject({ kind: "seeded", dropped: 1 })

    expect(loadAndStore(first.next, installed).outcome).toEqual({ kind: "restored", epoch: first.outcome.epoch })
  })

  it("an installed extension's block of a version newer than the build reads", () => {
    const NEWER = "blk-0453-newer-000001"
    const blockDoc = postWithAlerts()
    blockDoc.blocks_order = [...blockDoc.blocks_order, NEWER]
    blockDoc.blocks[NEWER] = { id: NEWER, type: ALERT_TYPE, version: 99, attrs: { variant: "info", text: "From the future" } }
    const first = loadAndStore({ block_doc: blockDoc, block_revision: 4, ydoc_state: null, epoch: null }, installed)
    expect(first.outcome).toMatchObject({ kind: "seeded", dropped: 1 })
    // meta.dropped holds an alert the schema knows, but a dry run drops it again.
    expect(readMeta(first.doc).dropped!.blocks[NEWER].type).toBe(ALERT_TYPE)

    expect(loadAndStore(first.next, installed).outcome).toEqual({ kind: "restored", epoch: first.outcome.epoch })
  })

  it("a stored state with only core blocks is applied as is", () => {
    const record = storedInstalled()
    expect(loadAndStore(record, installed).outcome).toEqual({ kind: "restored", epoch: record.epoch })
  })
})
