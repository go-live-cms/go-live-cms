import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { getCoreSchema, schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { findUnbuildableTypes } from "@gl-admin/lib/collaboration/schemaGuard"
import { EDITOR_FRAGMENT } from "@gl-admin/lib/collaboration/fragmentBridge"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { getInstalledCollabSchema } from "./collabSchema"
import { installedThemeBlocks } from "./installed"
import alert from "../../../themes/example/blocks/Alert/index"

// #453 on the real collab server (in process): a post whose stored Yjs state holds the
// example theme's alert, at the top level and in a Group, is opened after a deploy without
// the theme. The server reseeds it once (new epoch), so an editor without the alert binds
// and edits the rest; the store keeps the alert; a deploy with the theme back puts it back
// where it was. (Every case, the quote too, is in collab-server/reseed.test.ts.)

const editors: Editor[] = []

function makeEditor(doc: Y.Doc, { withTheme }: { withTheme: boolean }): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: true })),
      ...(withTheme ? installedThemeBlocks.map((block) => block.node) : []),
      Collaboration.configure({ document: doc }),
    ],
  })
  editors.push(editor)
  return editor
}

const PARA = "blk-0453-para-0000001"
const ALERT = "blk-0453-alert-000001"
const GROUP = "blk-0453-group-000001"
const IN_GROUP = "blk-0453-ingroup-00001"
const GROUP_ALERT = "blk-0453-galert-000001"

const paragraph = (id: string, text: string) => ({ id, type: "paragraph", version: 1, attrs: { text } }) as BlockDocV1["blocks"][string]
const alertBlock = (id: string, variant: string, text: string) =>
  ({ id, type: alert.type, version: 1, attrs: { variant, pm: { type: alert.type, content: [{ type: "text", text }] }, text } }) as BlockDocV1["blocks"][string]

const post: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [PARA, ALERT, GROUP],
  blocks: {
    [PARA]: paragraph(PARA, "Intro"),
    [ALERT]: alertBlock(ALERT, "warning", "Top"),
    [GROUP]: { id: GROUP, type: "group", version: 1, attrs: {}, children: [IN_GROUP, GROUP_ALERT] } as BlockDocV1["blocks"][string],
    [IN_GROUP]: paragraph(IN_GROUP, "In group"),
    [GROUP_ALERT]: alertBlock(GROUP_ALERT, "error", "Grouped"),
  },
}

const alertTexts = (editor: Editor): string[] => {
  const texts: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === alert.type) texts.push(`${node.attrs["data-block-id"]}:${node.attrs.variant}:${node.textContent}`)
  })
  return texts
}

describe("a stored doc holding an uninstalled theme's block, on the Hocuspocus relay (#453)", () => {
  let relay: Relay
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    relay = await startRelay({ schema: getInstalledCollabSchema() })
    relay.api.addPost("12", post, 3)
  })
  afterEach(async () => {
    while (editors.length) editors.pop()!.destroy()
    await relay.destroy()
    vi.restoreAllMocks()
  })

  it("opens editable without the theme (reseeded once, new epoch), keeps the block, and gets it back in place on reinstall", async () => {
    // Installed: seeded, stored as Yjs state (the seed's PUT).
    const pa = relay.client("1")
    await pa.whenSynced()
    const a = makeEditor(pa.doc, { withTheme: true })
    await waitFor(() => alertTexts(a).length === 2, { what: "a to load" })
    const installedEpoch = pa.getEpoch()
    await waitFor(() => !!relay.api.posts.get("12")!.state, { what: "the seed's store" })
    while (editors.length) editors.pop()!.destroy()
    pa.destroy()

    // A deploy without the theme. (Its tabs are refused by the fingerprint, #416; one holding
    // the old structs would be refused with stale-epoch too, reconnect.hocuspocus.test.ts.)
    await relay.restart(undefined, { schema: getCoreSchema() })

    // A fresh tab: a new epoch, and nothing it can't build, so it binds and edits.
    const pb = relay.client("1")
    await pb.whenSynced()
    const removedEpoch = pb.getEpoch()
    expect(removedEpoch).not.toBe(installedEpoch)
    const b = makeEditor(pb.doc, { withTheme: false })
    expect(findUnbuildableTypes(pb.doc.getXmlFragment(EDITOR_FRAGMENT), b.schema)).toBeNull()
    await waitFor(() => b.getText().includes("In group"), { what: "b to load" })
    expect(b.getText()).not.toContain("Top")
    let introEnd = -1
    b.state.doc.descendants((node, pos) => {
      if (introEnd === -1 && node.attrs["data-block-id"] === PARA) introEnd = pos + node.nodeSize - 1
    })
    b.commands.insertContentAt(introEnd, " edited")

    // The store keeps both alerts, at their places, beside the edit.
    const stored = () => relay.api.posts.get("12")!.block_doc!
    await waitFor(() => (stored().blocks[PARA]?.attrs as { text?: string }).text === "Intro edited", { what: "the store" })
    // (TipTap's TrailingNode may add an empty paragraph after the group.)
    expect(stored().blocks_order.slice(0, 3)).toEqual([PARA, ALERT, GROUP])
    expect(stored().blocks[GROUP].children).toEqual([IN_GROUP, GROUP_ALERT])
    expect(stored().blocks[ALERT]).toEqual(post.blocks[ALERT])
    expect(stored().blocks[GROUP_ALERT]).toEqual(post.blocks[GROUP_ALERT])
    while (editors.length) editors.pop()!.destroy()

    // Reseeded once: a restart on the same build restores the state as it is.
    await relay.restart()
    const pc = relay.client("1")
    await pc.whenSynced()
    expect(pc.getEpoch()).toBe(removedEpoch)
    pc.destroy()

    // A deploy with the theme back: both alerts are back in place, the edit kept.
    await relay.restart(undefined, { schema: getInstalledCollabSchema() })
    const pd = relay.client("1")
    await pd.whenSynced()
    expect(pd.getEpoch()).not.toBe(removedEpoch)
    const d = makeEditor(pd.doc, { withTheme: true })
    await waitFor(() => alertTexts(d).length === 2, { what: "the alerts back" })
    expect(alertTexts(d)).toEqual([`${ALERT}:warning:Top`, `${GROUP_ALERT}:error:Grouped`])
    expect(d.state.doc.child(0).textContent).toBe("Intro edited")
    expect(d.state.doc.child(1).type.name).toBe(alert.type)
    expect(d.state.doc.child(2).child(1).type.name).toBe(alert.type)
  }, 20_000)
})
