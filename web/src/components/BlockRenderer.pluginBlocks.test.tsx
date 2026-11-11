import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "./BlockRenderer"
import { blockRegistry } from "./blocks/registry"
import { log } from "../lib/log"

// Plugin blocks on the public page (#452): rendered like theme blocks (#376). No plugin is
// in the build yet (S6 adds the render.tsx glob), so the renderer is registered by hand.

const TYPE = "plugin:reading-time/estimate"
const doc = (blocks: BlockDocV1["blocks"]): BlockDocV1 => ({ doc_version: 1, blocks_order: Object.keys(blocks), blocks })

beforeAll(() => {
  blockRegistry.register({
    type: TYPE,
    version: 1,
    name: "Reading time",
    category: "design",
    icon: "",
    component: ({ block }) => <p className="reading-time">{String((block.attrs as { label?: unknown }).label ?? "min read")}</p>,
  })
})
afterAll(() => {
  blockRegistry.unregister(TYPE)
})

describe("plugin blocks in BlockRenderer (#452)", () => {
  it("an installed plugin block renders with its renderer", () => {
    const html = renderToStaticMarkup(
      <BlockRenderer doc={doc({ "blk-plugin-00001": { id: "blk-plugin-00001", type: TYPE, version: 1, attrs: { label: "minutes" } } })} />,
    )
    expect(html).toContain('<p class="reading-time">minutes</p>')
  })

  it("a plugin block newer than its installed renderer reads renders nothing", () => {
    const html = renderToStaticMarkup(
      <BlockRenderer doc={doc({ "blk-plugin-00002": { id: "blk-plugin-00002", type: TYPE, version: 2, attrs: { label: "v2" } } })} />,
    )
    expect(html).not.toContain("reading-time")
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
    warn.mockRestore()
  })
})
