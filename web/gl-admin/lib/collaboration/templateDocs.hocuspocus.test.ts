// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as Y from "yjs"
import type { BlockDocV1 } from "../blocks-spec"
import { appendParagraph, connect, paragraphDoc, paragraphs } from "../../../collab-server/testkit"
import { EDITOR_FRAGMENT } from "./fragmentBridge"
import { canonical } from "./fragmentBridge.fixtures"
import type { CollabAccess, HocuspocusCollaboration, StoreMessage } from "./HocuspocusCollaboration"
import { RECHECK_MS, startRelay, waitFor, type Relay } from "./hocuspocusRelay.testkit"

// The template-<id> document kind (#490, docs/design/theme-builder.md 7.2-7.3) on the real
// collab server in-process: the relay tests a post has (reconnect.hocuspocus.test.ts), on
// a template and a part. Same server, schema and fingerprint; a second API client
// (/internal/site-templates/:id/collab); admins only, enforced at connect and on every
// re-check, never read-only; each store validated with the template's kind.

const TEMPLATE_ID = 31
const PART_ID = 32

let relay: Relay

/** A template doc: the header part, the given paragraphs, the footer part. */
function templateDoc(...texts: string[]): BlockDocV1 {
  const doc = paragraphDoc(...texts)
  const header = "blk-part-header01"
  const footer = "blk-part-footer01"
  doc.blocks[header] = { id: header, type: "template_part", version: 1, attrs: { slug: "header" } } as unknown as BlockDocV1["blocks"][string]
  doc.blocks[footer] = { id: footer, type: "template_part", version: 1, attrs: { slug: "footer" } } as unknown as BlockDocV1["blocks"][string]
  doc.blocks_order = [header, ...doc.blocks_order, footer]
  return canonical(doc)
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  relay = await startRelay()
  relay.api.addTemplate(String(TEMPLATE_ID), templateDoc("one", "two"), "template", 3)
  relay.api.addTemplate(String(PART_ID), canonical(paragraphDoc("header text")), "part", 2)
})

afterEach(async () => {
  await relay.destroy()
  vi.restoreAllMocks()
})

const template = (id = TEMPLATE_ID) => relay.api.templates.get(String(id))!
const storedTypes = (id = TEMPLATE_ID) => template(id).block_doc!.blocks_order.map((blockId) => template(id).block_doc!.blocks[blockId].type)
const storedText = (id = TEMPLATE_ID) =>
  template(id)
    .block_doc!.blocks_order.map((blockId) => (template(id).block_doc!.blocks[blockId].attrs as { text?: string }).text)
    .filter((text) => text !== undefined)

const onTemplate = (userId: string, options: { epoch?: string; id?: number } = {}) =>
  relay.client(userId, { docKind: "template", postId: options.id ?? TEMPLATE_ID, epoch: options.epoch })

function storeMessages(client: HocuspocusCollaboration): StoreMessage[] {
  const messages: StoreMessage[] = []
  client.onStore((message) => messages.push(message))
  return messages
}

describe("template-<id>: the collab document kind for templates and parts (#490)", () => {
  it("two admins typing converge; the server seeds from the template's block_doc and stores it there", async () => {
    relay.api.users.set("4", { role: "admin" })
    const a = onTemplate("1")
    const b = onTemplate("4")
    expect(a.docName).toBe(`template-${TEMPLATE_ID}`)
    await Promise.all([a.whenSynced(), b.whenSynced()])
    expect(a.readOnly).toBe(false)
    expect(b.readOnly).toBe(false)
    // The server seeded the parts as site block nodes (one schema for both kinds, 7.4).
    const types = (doc: Y.Doc) => doc.getXmlFragment(EDITOR_FRAGMENT).toArray().map((node) => (node as Y.XmlElement).nodeName)
    expect(types(a.doc)).toEqual(["templatePart", "paragraph", "paragraph", "templatePart"])
    expect(a.getEpoch()).toBe(template().epoch)

    appendParagraph(a.doc, "from a", "blk-from-a-0001")
    appendParagraph(b.doc, "from b", "blk-from-b-0001")
    await waitFor(() => paragraphs(a.doc).length === 6 && paragraphs(b.doc).length === 6, { what: "convergence" })
    expect(paragraphs(a.doc)).toEqual(paragraphs(b.doc))

    await waitFor(() => storedText().length === 4, { what: "the store" })
    expect(storedTypes()).toEqual(["template_part", "paragraph", "paragraph", "template_part", "paragraph", "paragraph"])
    expect(storedText()).toEqual(expect.arrayContaining(["one", "two", "from a", "from b"]))
    // The template's API, never the post's; and no per-block attribution (7.2).
    expect(relay.api.puts).toEqual([])
    expect(relay.api.templatePuts.length).toBeGreaterThan(0)
    expect(relay.api.templatePuts.every((put) => put.body.block_edits === undefined)).toBe(true)
    expect(template().block_revision).toBeGreaterThan(3)
  })

  it("the stored doc keeps the parts by slug and comes back the same after a restart mid-edit", async () => {
    const a = onTemplate("1")
    await a.whenSynced()
    appendParagraph(a.doc, "before restart", "blk-before-0001")
    await waitFor(() => storedText().includes("before restart"), { what: "the store" })
    const header = template().block_doc!.blocks[template().block_doc!.blocks_order[0]]
    expect(header).toMatchObject({ type: "template_part", attrs: { slug: "header" } })

    await relay.restart(() => {
      // Typed while the server is down: queued, sent on reconnect.
      appendParagraph(a.doc, "while down", "blk-while-down1")
    })
    await waitFor(() => a.synced, { what: "the resync" })
    expect(a.stale).toBe(false)
    const expected = ["", "one", "two", "", "before restart", "while down"]
    await waitFor(() => storedText().includes("while down"), { what: "the store after the restart" })
    expect(paragraphs(a.doc)).toEqual(expected)

    // A fresh admin after the restart restores the stored state: nothing lost or doubled.
    const fresh = onTemplate("1")
    await fresh.whenSynced()
    expect(paragraphs(fresh.doc)).toEqual(expected)
    expect(storedText()).toEqual(["one", "two", "before restart", "while down"])
  })

  it("block_doc written around the server → reseeded under a new epoch → the old client is stale, a fresh one sees it once", async () => {
    const a = onTemplate("1")
    await a.whenSynced()
    const oldEpoch = a.getEpoch()
    const onStale = vi.fn()
    a.onStale(onStale)

    await relay.restart(() => {
      relay.api.writeAroundTemplate(String(TEMPLATE_ID), templateDoc("restored from a backup"))
    })
    await waitFor(() => onStale.mock.calls.length === 1, { what: "stale-epoch" })
    expect(a.stale).toBe(true)
    expect(a.destroyed).toBe(true)

    const fresh = onTemplate("1")
    await fresh.whenSynced()
    expect(paragraphs(fresh.doc)).toEqual(["", "restored from a backup", ""])
    expect(fresh.getEpoch()).not.toBe(oldEpoch)
    expect(template().epoch).toBe(fresh.getEpoch())
  })

  it("a client holding another epoch is refused with stale-epoch (it must not merge old structs)", async () => {
    const first = onTemplate("1")
    await first.whenSynced()
    const docName = `template-${TEMPLATE_ID}`
    // A raw client that already holds structs of an older seeding: it says so on the URL.
    const stale = connect(relay.url, docName, () => relay.ticket("1", docName), { epoch: "00000000-0000-4000-8000-000000000000" })
    try {
      expect(await stale.outcome).toEqual({ synced: false, reason: "stale-epoch" })
      // The same epoch the server has is accepted.
      const current = connect(relay.url, docName, () => relay.ticket("1", docName), { epoch: first.getEpoch()! })
      try {
        expect(await current.outcome).toEqual({ synced: true, readOnly: false })
      } finally {
        current.destroy()
      }
    } finally {
      stale.destroy()
    }
    expect(paragraphs(first.doc)).toEqual(["", "one", "two", ""])
  })

  it("an editor is refused at connect: no read-only view of a template", async () => {
    const editor = onTemplate("2")
    await waitFor(() => editor.getStatus() === "denied", { what: "the denial" })
    expect(editor.synced).toBe(false)
    expect(paragraphs(editor.doc)).toEqual([])
    // A contributor too.
    const contributor = onTemplate("3")
    await waitFor(() => contributor.getStatus() === "denied", { what: "the contributor's denial" })
    // The same editor may still open a post (read-write): the kind decides, not the role alone.
    const post = relay.client("2")
    await post.whenSynced()
    expect(post.readOnly).toBe(false)
  })

  it("an admin demoted while connected is closed with access-revoked on the re-check, never made read-only", async () => {
    const admin = onTemplate("1")
    const changes: CollabAccess[] = []
    admin.onAccess((access) => changes.push(access))
    await admin.whenSynced()
    await waitFor(() => relay.server.recheckedConnections > 0, { what: "the server to track the connection" })
    appendParagraph(admin.doc, "kept locally", "blk-kept-0000001")
    await waitFor(() => storedText().includes("kept locally"), { what: "the store" })

    relay.api.users.set("1", { role: "editor" })
    await relay.clock.advance(RECHECK_MS)
    await waitFor(() => changes.length === 1, { what: "the revoke" })
    expect(changes[0]).toEqual({ readOnly: true, reason: null, revoked: true })
    expect(changes.some((change) => change.reason === "demoted")).toBe(false)
    expect(admin.revoked).toBe(true)
    expect(admin.getStatus()).toBe("revoked")
    expect(paragraphs(admin.doc)).toContain("kept locally")
    await waitFor(() => relay.server.recheckedConnections === 0, { what: "the server to drop it" })
  })

  it("a part stores as a part; a template_part written into it is kept-invalid and block_doc keeps its last valid version", async () => {
    const admin = onTemplate("1", { id: PART_ID })
    const messages = storeMessages(admin)
    await admin.whenSynced()
    appendParagraph(admin.doc, "menu", "blk-part-menu001")
    await waitFor(() => messages.some((m) => m.type === "stored" && m.block_doc === "written"), { what: "a written store" })
    expect(storedText(PART_ID)).toEqual(["header text", "menu"])
    const lastValid = structuredClone(template(PART_ID).block_doc)
    const revision = template(PART_ID).block_revision

    // A client writing a part into the part's Yjs doc directly (no editor offers it there).
    const fragment = admin.doc.getXmlFragment(EDITOR_FRAGMENT)
    admin.doc.transact(() => {
      const nested = new Y.XmlElement("templatePart")
      nested.setAttribute("data-block-id", "blk-nested-part1")
      nested.setAttribute("slug", "footer")
      fragment.insert(fragment.length, [nested])
    })
    await waitFor(() => messages.some((m) => m.type === "stored" && m.block_doc === "kept-invalid"), { what: "the kept-invalid store" })
    expect(template(PART_ID).block_doc).toEqual(lastValid)
    expect(template(PART_ID).block_revision).toBe(revision)
    // The state was stored (without block_doc), so nothing typed is lost.
    expect(template(PART_ID).state_revision).toBe(revision)

    // The same block in a template is fine: the kind decides.
    const onTpl = onTemplate("1")
    const tplMessages = storeMessages(onTpl)
    await onTpl.whenSynced()
    const tplFragment = onTpl.doc.getXmlFragment(EDITOR_FRAGMENT)
    onTpl.doc.transact(() => {
      const promo = new Y.XmlElement("templatePart")
      promo.setAttribute("data-block-id", "blk-promo-part01")
      promo.setAttribute("slug", "promo_bar")
      tplFragment.insert(1, [promo])
    })
    await waitFor(() => tplMessages.some((m) => m.type === "stored" && m.block_doc === "written"), { what: "the template's store" })
    expect(template().block_doc!.blocks["blk-promo-part01"]).toMatchObject({ type: "template_part", attrs: { slug: "promo_bar" } })
  })

  it("flush stores a template document; a template that doesn't exist refuses the connection", async () => {
    const admin = onTemplate("1")
    await admin.whenSynced()
    appendParagraph(admin.doc, "flushed", "blk-flushed-0001")
    await waitFor(() => relay.server.hocuspocus.documents.get(`template-${TEMPLATE_ID}`) !== undefined, { what: "the doc" })
    await waitFor(() => paragraphs(relay.server.hocuspocus.documents.get(`template-${TEMPLATE_ID}`)!).includes("flushed"), { what: "the edit on the server" })
    const result = await relay.server.flush(`template-${TEMPLATE_ID}`)
    expect(result).toMatchObject({ ok: true, loaded: true })
    expect(storedText()).toContain("flushed")

    const missing = onTemplate("1", { id: 999 })
    await waitFor(() => missing.getStatus() === "denied", { what: "the refusal" })
  })
})
