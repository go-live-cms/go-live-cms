import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createRoot } from "react-dom/client"
import { act } from "react"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "./BlockRenderer"
import { blockRegistry } from "./blocks/registry"
import { log } from "../lib/log"
import { resetPluginBlockFailureLog } from "./blocks/PluginBlockBoundary"

// Plugin blocks on the public page (#452, #456): rendered like theme blocks (#376), each
// inside its own safeguard (PluginBlockBoundary). The repository's example plugin is
// registered by the build's glob; these tests register their own renderers by hand.

const TYPE = "plugin:test-only/widget"
const THROWS = "plugin:test-only/broken"
const THROWS_DEEP = "plugin:test-only/broken-child"
const doc = (blocks: BlockDocV1["blocks"]): BlockDocV1 => ({ doc_version: 1, blocks_order: Object.keys(blocks), blocks })

function Exploding(): React.ReactElement {
  throw new Error("renderer exploded")
}

beforeAll(() => {
  blockRegistry.register({
    type: TYPE,
    version: 1,
    name: "Widget",
    category: "design",
    icon: "",
    component: ({ block }) => <p className="widget">{String((block.attrs as { label?: unknown }).label ?? "widget")}</p>,
  })
  blockRegistry.register({
    type: THROWS,
    version: 1,
    name: "Broken",
    category: "design",
    icon: "",
    component: () => {
      throw new Error("renderer exploded")
    },
  })
  // Throws in a component the renderer renders, not in the renderer itself.
  blockRegistry.register({
    type: THROWS_DEEP,
    version: 1,
    name: "Broken child",
    category: "design",
    icon: "",
    component: () => (
      <div className="broken-child">
        <Exploding />
      </div>
    ),
  })
})
afterAll(() => {
  for (const type of [TYPE, THROWS, THROWS_DEEP]) blockRegistry.unregister(type)
})
afterEach(() => {
  vi.restoreAllMocks()
  resetPluginBlockFailureLog()
})

const page = (broken: string) =>
  doc({
    "blk-para-00000001": { id: "blk-para-00000001", type: "paragraph", version: 1, attrs: { text: "Before", pm: { type: "paragraph", content: [{ type: "text", text: "Before" }] } } },
    "blk-broken-000001": { id: "blk-broken-000001", type: broken, version: 1, attrs: { label: "secret" } },
    "blk-plugin-00001": { id: "blk-plugin-00001", type: TYPE, version: 1, attrs: { label: "still here" } },
    "blk-para-00000002": { id: "blk-para-00000002", type: "paragraph", version: 1, attrs: { text: "After", pm: { type: "paragraph", content: [{ type: "text", text: "After" }] } } },
  })

describe("plugin blocks in BlockRenderer (#452)", () => {
  it("an installed plugin block renders with its renderer, its markup unwrapped", () => {
    const html = renderToStaticMarkup(
      <BlockRenderer doc={doc({ "blk-plugin-00001": { id: "blk-plugin-00001", type: TYPE, version: 1, attrs: { label: "minutes" } } })} />,
    )
    expect(html).toBe('<div class="block-content"><p class="widget">minutes</p></div>')
  })

  it("a plugin block newer than its installed renderer reads renders nothing", () => {
    const html = renderToStaticMarkup(
      <BlockRenderer doc={doc({ "blk-plugin-00002": { id: "blk-plugin-00002", type: TYPE, version: 2, attrs: { label: "v2" } } })} />,
    )
    expect(html).not.toContain("widget")
  })

  it("a block of a plugin that isn't installed renders nothing, and is logged once", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {})
    const gone = doc({
      "blk-para-00000001": { id: "blk-para-00000001", type: "paragraph", version: 1, attrs: { text: "Before" } },
      "blk-gone-00000001": { id: "blk-gone-00000001", type: "plugin:gone/widget", version: 3, attrs: { text: "secret" } },
    })
    const html = renderToStaticMarkup(<BlockRenderer doc={gone} />)
    renderToStaticMarkup(<BlockRenderer doc={gone} />)
    expect(html).toContain("Before")
    expect(html).not.toContain("secret")
    expect(warn.mock.calls.filter(([, fields]) => fields?.type === "plugin:gone/widget")).toHaveLength(1)
  })

  it("the example plugin's block renders on the public page (it is in the build)", () => {
    const html = renderToStaticMarkup(
      <BlockRenderer
        doc={doc({
          "blk-para-00000001": { id: "blk-para-00000001", type: "paragraph", version: 1, attrs: { text: "one two three" } },
          "blk-estimate-0001": { id: "blk-estimate-0001", type: "plugin:reading-time/estimate", version: 1, attrs: { label: "minutes to read" } },
        })}
      />,
    )
    expect(html).toContain('class="gl-reading-time">1 minutes to read</p>')
  })
})

// #456: the user's decision. A renderer that throws renders nothing for its block, shows no
// error text, and is logged with the plugin, the type and the error; the rest renders.
describe("a plugin renderer that throws (#456)", () => {
  // The browser path: the admin's History preview, a theme that hydrates (jsdom has a window).
  for (const broken of [THROWS, THROWS_DEEP]) {
    it(`in a browser, hides only its block and logs it (${broken})`, async () => {
      const error = vi.spyOn(log, "error").mockImplementation(() => {})
      vi.spyOn(console, "error").mockImplementation(() => {}) // React's own report of the caught error
      const container = document.createElement("div")
      const root = createRoot(container)
      await act(async () => root.render(<BlockRenderer doc={page(broken)} />))
      const html = container.innerHTML
      await act(async () => root.unmount())

      expect(html).toContain("Before")
      expect(html).toContain("still here")
      expect(html).toContain("After")
      expect(html).not.toContain("secret")
      expect(html).not.toContain("exploded")
      expect(html).not.toContain("broken-child")
      expect(error).toHaveBeenCalledWith("plugin_block_render_failed", expect.objectContaining({ plugin: "test-only", type: broken, block_id: "blk-broken-000001" }))
      expect(String((error.mock.calls[0][1] as { error?: unknown }).error)).toContain("renderer exploded")
    })
  }

  it("theme and core blocks don't go through the safeguard", async () => {
    blockRegistry.register({
      type: "theme:test-only/broken",
      version: 1,
      name: "Broken theme block",
      category: "design",
      icon: "",
      component: () => {
        throw new Error("theme renderer exploded")
      },
    })
    try {
      vi.spyOn(console, "error").mockImplementation(() => {})
      expect(() =>
        renderToStaticMarkup(
          <BlockRenderer doc={doc({ "blk-theme-000001": { id: "blk-theme-000001", type: "theme:test-only/broken", version: 1, attrs: {} } })} />,
        ),
      ).toThrow("theme renderer exploded")
    } finally {
      blockRegistry.unregister("theme:test-only/broken")
    }
  })
})
