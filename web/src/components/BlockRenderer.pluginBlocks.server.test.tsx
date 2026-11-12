// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest"
import React, { useContext } from "react"
import { Writable } from "node:stream"
import { renderToStaticMarkup, renderToString, renderToPipeableStream } from "react-dom/server"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "./BlockRenderer"
import { blockRegistry } from "./blocks/registry"
import { PluginBlockBoundary, resetPluginBlockFailureLog, setPluginBlockServerProbe } from "./blocks/PluginBlockBoundary"
import { BLOCK_IMAGE_SIZES, ImageSizesContext } from "./blocks/utils/responsiveImage"
import { log } from "../lib/log"
// What the middleware loads in production: registers react-dom/server as the probe.
import "../lib/pluginBlockProbe"

// #456 on the server (no window): React has no error boundaries in SSR, so the safeguard
// renders each plugin block on its own first (PluginBlockBoundary's probe). A renderer that
// throws hides its block, writes no error text into the page, is logged, and the rest of
// the page renders, whichever React server API renders it. Astro's React renderer uses
// renderToPipeableStream on Node and rejects the whole component on any onError, even one
// inside a Suspense boundary, which is why a Suspense fallback couldn't be the safeguard.

const OK = "plugin:test-server/widget"
const THROWS = "plugin:test-server/broken"
const doc = (blocks: BlockDocV1["blocks"]): BlockDocV1 => ({ doc_version: 1, blocks_order: Object.keys(blocks), blocks })
const page = doc({
  "blk-para-00000001": { id: "blk-para-00000001", type: "paragraph", version: 1, attrs: { text: "Before", pm: { type: "paragraph", content: [{ type: "text", text: "Before" }] } } },
  "blk-broken-000001": { id: "blk-broken-000001", type: THROWS, version: 1, attrs: { label: "secret" } },
  "blk-plugin-00001": { id: "blk-plugin-00001", type: OK, version: 1, attrs: {} },
  "blk-para-00000002": { id: "blk-para-00000002", type: "paragraph", version: 1, attrs: { text: "After", pm: { type: "paragraph", content: [{ type: "text", text: "After" }] } } },
})

function SizesProbe() {
  return <span className="sizes">{useContext(ImageSizesContext)}</span>
}

beforeAll(() => {
  blockRegistry.register({ type: OK, version: 1, name: "Widget", category: "design", icon: "", component: () => <SizesProbe /> })
  blockRegistry.register({
    type: THROWS,
    version: 1,
    name: "Broken",
    category: "design",
    icon: "",
    component: ({ block }) => {
      throw new Error(`renderer exploded on ${String((block.attrs as { label?: unknown }).label)}`)
    },
  })
})
afterAll(() => {
  blockRegistry.unregister(OK)
  blockRegistry.unregister(THROWS)
})
afterEach(() => {
  vi.restoreAllMocks()
  resetPluginBlockFailureLog()
})

/** As @astrojs/react's renderToPipeableStreamAsync: any reported error rejects the render. */
function renderLikeAstro(element: React.ReactElement): Promise<string> {
  return new Promise((resolve, reject) => {
    let html = ""
    const stream = renderToPipeableStream(element, {
      onError: reject,
      onAllReady() {
        stream.pipe(
          new Writable({
            write(chunk, _encoding, callback) {
              html += chunk.toString("utf-8")
              callback()
            },
            final(callback) {
              resolve(html)
              callback()
            },
          }),
        )
      },
    })
  })
}

describe("a plugin renderer that throws, on the server (#456)", () => {
  const renders: [string, (element: React.ReactElement) => Promise<string> | string][] = [
    ["renderToStaticMarkup", renderToStaticMarkup],
    ["renderToString", renderToString],
    ["renderToPipeableStream, as Astro renders", renderLikeAstro],
  ]
  for (const [name, render] of renders) {
    it(`hides only its block and logs plugin, type and error (${name})`, async () => {
      expect(typeof window).toBe("undefined")
      const error = vi.spyOn(log, "error").mockImplementation(() => {})
      const html = await render(<BlockRenderer doc={page} imageSizes="100vw" />)
      expect(html).toContain("Before")
      expect(html).toContain("After")
      // The block after it renders, with the contexts BlockRenderer gives it.
      expect(html).toContain('<span class="sizes">100vw</span>')
      expect(html).not.toContain("secret")
      expect(html).not.toContain("exploded")
      expect(error).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledWith("plugin_block_render_failed", expect.objectContaining({ plugin: "test-server", type: THROWS, block_id: "blk-broken-000001" }))
      expect(String((error.mock.calls[0][1] as { error?: unknown }).error)).toContain("renderer exploded")
    })
  }

  it("a page without a failing block renders exactly as before (no wrapper markup)", () => {
    const html = renderToStaticMarkup(<BlockRenderer doc={doc({ "blk-plugin-00001": { id: "blk-plugin-00001", type: OK, version: 1, attrs: {} } })} />)
    expect(html).toBe(`<div class="block-content"><span class="sizes">${BLOCK_IMAGE_SIZES}</span></div>`)
  })

  it("without the probe registered, says so once and renders unguarded", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {})
    setPluginBlockServerProbe(null)
    try {
      expect(renderToStaticMarkup(<BlockRenderer doc={doc({ "blk-plugin-00001": { id: "blk-plugin-00001", type: OK, version: 1, attrs: {} } })} />)).toContain("sizes")
      expect(() => renderToStaticMarkup(<BlockRenderer doc={page} />)).toThrow("renderer exploded")
      expect(warn.mock.calls.filter(([msg]) => msg === "plugin_block_probe_missing")).toHaveLength(1)
    } finally {
      setPluginBlockServerProbe((element) => {
        renderToStaticMarkup(element)
      })
    }
  })

  // A group (#414) holding plugin blocks: the probe runs inside the container's own render.
  it("hides a broken plugin block inside a group, and renders the one beside it", () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {})
    const grouped: BlockDocV1 = {
      doc_version: 1,
      blocks_order: ["blk-group-0000001"],
      blocks: {
        "blk-group-0000001": { id: "blk-group-0000001", type: "group", version: 1, attrs: {}, children: ["blk-broken-000001", "blk-plugin-00001"] },
        "blk-broken-000001": { id: "blk-broken-000001", type: THROWS, version: 1, attrs: { label: "secret" } },
        "blk-plugin-00001": { id: "blk-plugin-00001", type: OK, version: 1, attrs: {} },
      },
    } as BlockDocV1
    const html = renderToStaticMarkup(<BlockRenderer doc={grouped} imageSizes="50vw" />)
    expect(html).toContain('class="group')
    expect(html).toContain('<span class="sizes">50vw</span>')
    expect(html).not.toContain("secret")
    expect(error).toHaveBeenCalledTimes(1)
  })

  // A hidden block's footnote references are left out of the numbering and the list's back
  // links, so no link points at an anchor that isn't on the page.
  it("leaves a hidden block's footnote references out of the footnotes", () => {
    vi.spyOn(log, "error").mockImplementation(() => {})
    const ref = (footnoteId: string) => ({ type: "footnoteRef", attrs: { footnoteId } })
    const note = (id: string, value: string) => ({ id, type: "footnote", version: 1, attrs: { pm: { type: "footnote", content: [{ type: "text", text: value }] }, text: value } })
    const withNotes = {
      doc_version: 1,
      blocks_order: ["blk-broken-000001", "para-00001", "notes-0001"],
      blocks: {
        "blk-broken-000001": { id: "blk-broken-000001", type: THROWS, version: 1, attrs: { pm: { type: THROWS, content: [ref("note-00001")] } } },
        "para-00001": { id: "para-00001", type: "paragraph", version: 1, attrs: { pm: { type: "paragraph", content: [{ type: "text", text: "Text" }, ref("note-00002")] } } },
        "notes-0001": { id: "notes-0001", type: "footnotes", version: 1, attrs: {}, children: ["note-00001", "note-00002"] },
        "note-00001": note("note-00001", "From the hidden block."),
        "note-00002": note("note-00002", "From the paragraph."),
      },
    } as unknown as BlockDocV1
    const html = renderToStaticMarkup(<BlockRenderer doc={withNotes} />)
    expect(html).toContain('<li id="fn-1">From the paragraph.')
    expect(html).not.toContain("From the hidden block.")
    for (const target of [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])) expect(html).toContain(`id="${target}"`)
  })

  it("a boundary rendered without BlockRenderer probes on its own", () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {})
    const Broken = () => {
      throw new Error("alone")
    }
    expect(
      renderToStaticMarkup(
        <div>
          <PluginBlockBoundary type={THROWS} blockId="blk-alone-000001">
            <Broken />
          </PluginBlockBoundary>
          kept
        </div>,
      ),
    ).toBe("<div>kept</div>")
    expect(error).toHaveBeenCalledWith("plugin_block_render_failed", expect.objectContaining({ type: THROWS, block_id: "blk-alone-000001" }))
  })

  it("logs a type's failures at most once a minute, then says how many it left out", () => {
    vi.useFakeTimers()
    try {
      const error = vi.spyOn(log, "error").mockImplementation(() => {})
      for (let i = 0; i < 5; i += 1) renderToStaticMarkup(<BlockRenderer doc={page} />)
      expect(error).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(60_001)
      renderToStaticMarkup(<BlockRenderer doc={page} />)
      expect(error).toHaveBeenCalledTimes(2)
      expect(error.mock.calls[1][1]).toMatchObject({ type: THROWS, suppressed: 4 })
    } finally {
      vi.useRealTimers()
    }
  })
})
