import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import type { BlockDocV1 } from "../blocks-spec"
import { paragraphDoc, paragraphs } from "../../../collab-server/testkit"
import type { SiteTemplate } from "../api/siteDesign"
import { canonical } from "./fragmentBridge.fixtures"
import { CollabSaveStatus } from "./CollabSaveStatus"
import type { HocuspocusCollaboration } from "./HocuspocusCollaboration"
import { schemaExtensions } from "./schema"
import { startRelay, waitFor, type Relay } from "./hocuspocusRelay.testkit"
import {
  discardTemplateChanges,
  NeverPublishedError,
  ResetVersionError,
  restoreTemplateVersion,
  startOverTemplate,
  type TemplateRestoreApi,
  type TemplateRestoreTarget,
} from "./templateRestore"

// Restore, Discard changes and Start over for a template (#492, rule 9) on the real collab
// server in-process: the doc goes into the working copy through a bound editor on
// template-<id>, every peer gets it as an ordinary edit, the server's store (the template's
// internal PUT) persists it, and only then is the API told, to record it. Nothing writes
// block_doc around the collab server (rule 11): the epoch never changes.

const TEMPLATE_ID = 31

let relay: Relay
const editors: Editor[] = []

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
  relay = await startRelay()
  relay.api.addTemplate(String(TEMPLATE_ID), templateDoc("working one", "working two"), "template", 3)
  relay.api.users.set("4", { role: "admin" })
})

afterEach(async () => {
  while (editors.length) editors.pop()!.destroy()
  await relay.destroy()
  vi.restoreAllMocks()
})

async function peer(userId: string): Promise<{ editor: Editor; collab: HocuspocusCollaboration; status: CollabSaveStatus; target: TemplateRestoreTarget }> {
  const collab = relay.client(userId, { docKind: "template", postId: TEMPLATE_ID })
  await collab.whenSynced()
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [...Object.values(schemaExtensions({ collaborating: true })), Collaboration.configure({ document: collab.doc })],
  })
  editors.push(editor)
  const status = new CollabSaveStatus(collab)
  return { editor, collab, status, target: { editor, ydoc: collab.doc, status, templateId: TEMPLATE_ID } }
}

const stored = () => relay.api.templates.get(String(TEMPLATE_ID))!
const storedTexts = () =>
  stored()
    .block_doc!.blocks_order.map((id) => (stored().block_doc!.blocks[id].attrs as { text?: string }).text)
    .filter((text): text is string => text !== undefined)
// The block types, without the empty paragraph the editor keeps after a final atom (TrailingNode).
const storedTypes = () =>
  stored()
    .block_doc!.blocks_order.map((id) => stored().block_doc!.blocks[id])
    .filter((block) => !(block.type === "paragraph" && !(block.attrs as { text?: string }).text))
    .map((block) => block.type)

/** A fake of the API routes the flows call; each record call notes what the server had stored by then. */
function fakeApi(versions: Record<number, BlockDocV1 | null>) {
  const recordedAfter: string[][] = []
  const row = (working_state: "custom" | "reset" = "custom") => ({ id: TEMPLATE_ID, working_state }) as SiteTemplate
  const api: TemplateRestoreApi = {
    getSiteTemplateVersion: vi.fn(async (_id: number, no: number) => ({ version_no: no, reset: versions[no] === null, block_doc: versions[no] })),
    recordSiteTemplateRestore: vi.fn(async () => {
      recordedAfter.push(storedTexts())
      return row()
    }),
    getSiteTemplateDefault: vi.fn(async () => ({ source: "starter" as const, source_hash: "abc", block_doc: templateDoc() })),
    recordSiteTemplateStartOver: vi.fn(async () => {
      recordedAfter.push(storedTexts())
      return row()
    }),
  }
  return { api, recordedAfter }
}

describe("template restore through the editor (#492, rule 9)", () => {
  it("restores a version into the live doc: the peer gets it, the server stores it, then the API records it", async () => {
    const a = await peer("1")
    const b = await peer("4")
    const epoch = stored().epoch
    const putsBefore = relay.api.templatePuts.length
    const { api, recordedAfter } = fakeApi({ 2: templateDoc("version two") })

    const result = await restoreTemplateVersion(a.target, 2, { api })
    expect(result.saved).toBe(true)

    // The server's store holds it, the parts by slug included…
    expect(storedTexts()).toEqual(["version two"])
    expect(storedTypes()).toEqual(["template_part", "paragraph", "template_part"])
    expect(relay.api.templatePuts.length).toBeGreaterThan(putsBefore)
    // …the API was told only after that store (it writes no block_doc)…
    expect(api.recordSiteTemplateRestore).toHaveBeenCalledWith(TEMPLATE_ID, 2)
    expect(recordedAfter).toEqual([["version two"]])
    // …and the peer got it as an ordinary edit, on the same epoch (no reseed, no write around).
    await waitFor(() => paragraphs(b.collab.doc).join("|").includes("version two"), { what: "the peer" })
    expect(b.editor.getText()).toContain("version two")
    expect(stored().epoch).toBe(epoch)
    expect(relay.api.puts).toEqual([])
  })

  it("Discard changes restores the published version; never published or a reset version throws, recording nothing", async () => {
    const a = await peer("1")
    const { api } = fakeApi({ 3: templateDoc("published"), 4: null })

    await expect(discardTemplateChanges(a.target, { published_version_no: null }, { api })).rejects.toBeInstanceOf(NeverPublishedError)
    await expect(restoreTemplateVersion(a.target, 4, { api })).rejects.toBeInstanceOf(ResetVersionError)
    expect(api.recordSiteTemplateRestore).not.toHaveBeenCalled()
    expect(paragraphs(a.collab.doc)).toContain("working one")

    await discardTemplateChanges(a.target, { published_version_no: 3 }, { api })
    expect(storedTexts()).toEqual(["published"])
    expect(api.recordSiteTemplateRestore).toHaveBeenCalledWith(TEMPLATE_ID, 3)
  })

  it("Start over puts the default in through the editor, then records its source", async () => {
    const a = await peer("1")
    const { api, recordedAfter } = fakeApi({})
    await startOverTemplate(a.target, { api })
    expect(storedTexts()).toEqual([])
    expect(storedTypes()).toEqual(["template_part", "template_part"])
    expect(api.recordSiteTemplateStartOver).toHaveBeenCalledWith(TEMPLATE_ID, "starter")
    expect(recordedAfter).toEqual([[]])
  })

  it("a read-only editor (a reset item not unlocked) restores nothing and records nothing", async () => {
    const a = await peer("1")
    a.editor.setEditable(false)
    const { api } = fakeApi({ 2: templateDoc("version two") })
    await expect(restoreTemplateVersion(a.target, 2, { api })).rejects.toThrow(/read-only/)
    expect(api.recordSiteTemplateRestore).not.toHaveBeenCalled()
    expect(storedTexts()).toEqual(["working one", "working two"])
  })
})
