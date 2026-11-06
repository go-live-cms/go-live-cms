import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "../BlockRenderer"

// The callout, pull quote and to-do list on the public page (#419, "Published · text"):
// the markup the default theme styles, the callout's tone said in words, read-only
// labelled checkboxes, the citation as text, and unknown values rendered as defaults.

const CALLOUT = "blk-callout-00001"
const PULL = "blk-pullquote-001"
const TODO = "blk-todo-list-001"
const T1 = "blk-todo-item-001"
const T2 = "blk-todo-item-002"
const GROUP = "blk-group-0000001"
const INNER = "blk-callout-00002"

const text = (value: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) })

function doc(overrides: Record<string, unknown> = {}): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [CALLOUT, PULL, TODO, GROUP],
    blocks: {
      [CALLOUT]: {
        id: CALLOUT,
        type: "callout",
        version: 1,
        attrs: {
          tone: "warning",
          pm: {
            type: "callout",
            content: [
              { type: "paragraph", content: [text("Restoring a version "), text("replaces", [{ type: "bold" }]), text(" the working copy.")] },
              { type: "paragraph", content: [text("Read the "), text("guide", [{ type: "link", attrs: { href: "/guide" } }])] },
            ],
          },
        },
      },
      [PULL]: { id: PULL, type: "pull_quote", version: 1, attrs: { cite: "Ana <Costa>", pm: { type: "pullQuote", content: [text("Now the editor opens it")] } } },
      [TODO]: { id: TODO, type: "todo_list", version: 1, attrs: {}, children: [T1, T2] },
      [T1]: { id: T1, type: "todo_item", version: 1, attrs: { checked: true, pm: { type: "taskItem", content: [{ type: "paragraph", content: [text("Write it")] }] } } },
      [T2]: { id: T2, type: "todo_item", version: 1, attrs: { checked: false, text: "Publish it" } },
      [GROUP]: { id: GROUP, type: "group", version: 1, attrs: {}, children: [INNER] },
      [INNER]: { id: INNER, type: "callout", version: 1, attrs: { tone: "loud", text: "Inside a group" } },
      ...overrides,
    },
  } as unknown as BlockDocV1
}

const render = (d: BlockDocV1) => renderToStaticMarkup(<BlockRenderer doc={d} />)

describe("callout (#419)", () => {
  it("is div.callout.is-<tone>, role=note, a hidden icon and the tone said in words", () => {
    const html = render(doc())
    expect(html).toContain(`<div id="b-${CALLOUT}" class="callout is-warning" role="note"><svg`)
    expect(html).toMatch(/class="callout is-warning" role="note"><svg [^>]*aria-hidden="true"[^>]*><path d="M12 3 2 20h20z/)
    expect(html).toContain(
      '<div class="callout-body"><p><span class="sr-only">Warning: </span>Restoring a version <strong>replaces</strong> the working copy.</p><p>Read the <a href="/guide"',
    )
    // The label only once per callout, in its first paragraph.
    const first = html.slice(html.indexOf(`id="b-${CALLOUT}"`), html.indexOf(`id="b-${PULL}"`))
    expect(first.match(/sr-only/g)).toHaveLength(1)
  })

  it("renders every tone, and an unknown or missing one as info; works inside a group", () => {
    for (const tone of ["info", "success", "warning", "danger"]) {
      const html = render(doc({ [CALLOUT]: { id: CALLOUT, type: "callout", version: 1, attrs: { tone, text: "x" } } }))
      const label = tone[0].toUpperCase() + tone.slice(1)
      expect(html).toContain(`class="callout is-${tone}"`)
      expect(html).toContain(`<span class="sr-only">${label}: </span>x`)
    }
    const html = render(doc())
    // The group's callout has an unknown tone: info, and no anchor of its own.
    expect(html).toContain(`<div id="b-${GROUP}" class="group"><div class="callout is-info" role="note">`)
    expect(html).toContain('<span class="sr-only">Info: </span>Inside a group')
  })
})

describe("pull quote (#419)", () => {
  it("is figure.pullquote > blockquote > p, with the citation as escaped text in figcaption", () => {
    const html = render(doc())
    expect(html).toContain(
      `<figure id="b-${PULL}" class="pullquote"><blockquote><p>Now the editor opens it</p></blockquote><figcaption>Ana &lt;Costa&gt;</figcaption></figure>`,
    )
  })

  it("has no figcaption without a citation (blank or not text)", () => {
    for (const cite of [undefined, "   ", 5]) {
      const html = render(doc({ [PULL]: { id: PULL, type: "pull_quote", version: 1, attrs: { cite, text: "Plain" } } }))
      expect(html).toContain('<figure id="b-blk-pullquote-001" class="pullquote"><blockquote><p>Plain</p></blockquote></figure>')
    }
  })
})

describe("nested in a quote or a list item (#419)", () => {
  it("renders with the same markup from the parent's pm, not dropped", () => {
    const QUOTE = "blk-quote-000001"
    const LIST = "blk-list-0000001"
    const ITEM = "blk-item-0000001"
    const nested = {
      doc_version: 1,
      blocks_order: [QUOTE, LIST],
      blocks: {
        [QUOTE]: {
          id: QUOTE,
          type: "blockquote",
          version: 2,
          attrs: {
            pm: {
              type: "blockquote",
              content: [
                { type: "paragraph", content: [text("Said once")] },
                { type: "callout", attrs: { tone: "success" }, content: [{ type: "paragraph", content: [text("Nested note")] }] },
                { type: "pullQuote", attrs: { cite: "Ana" }, content: [text("Nested pull")] },
              ],
            },
          },
        },
        [LIST]: { id: LIST, type: "bullet_list", version: 1, attrs: {}, children: [ITEM] },
        [ITEM]: {
          id: ITEM,
          type: "list_item",
          version: 1,
          attrs: {
            pm: {
              type: "listItem",
              content: [
                { type: "paragraph", content: [text("Steps")] },
                {
                  type: "taskList",
                  content: [
                    { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [text("Wri"), text("te", [{ type: "bold" }])] }] },
                  ],
                },
              ],
            },
          },
        },
      },
    } as unknown as BlockDocV1
    const html = render(nested)
    expect(html).toContain('<div class="callout is-success" role="note">')
    expect(html).toContain('<span class="sr-only">Success: </span>Nested note')
    expect(html).toContain('<figure class="pullquote"><blockquote><p>Nested pull</p></blockquote><figcaption>Ana</figcaption></figure>')
    expect(html).toContain(
      '<ul class="todo-list"><li class="todo-item is-checked"><input type="checkbox" disabled="" readOnly="" aria-label="Write" checked=""/><span class="todo-item__text">Wri<strong>te</strong></span></li></ul>',
    )
  })
})

describe("to-do list (#419)", () => {
  it("is ul.todo-list with a read-only checkbox per item, labelled by its text", () => {
    const html = render(doc())
    expect(html).toContain(`<ul id="b-${TODO}" class="todo-list">`)
    expect(html).toContain(
      `<li class="todo-item is-checked"><input type="checkbox" disabled="" readOnly="" aria-labelledby="todo-${T1}" checked=""/><span class="todo-item__text" id="todo-${T1}">Write it</span></li>`,
    )
    expect(html).toContain(
      `<li class="todo-item"><input type="checkbox" disabled="" readOnly="" aria-labelledby="todo-${T2}"/><span class="todo-item__text" id="todo-${T2}">Publish it</span></li>`,
    )
    // Nothing a reader can toggle.
    expect(html).not.toMatch(/<input(?![^>]*disabled)[^>]*>/)
  })

  it("an item whose id isn't safe in HTML gets an aria-label instead; a missing item renders nothing", () => {
    const BAD = "bad id <x>!!"
    const html = render(
      doc({
        [TODO]: { id: TODO, type: "todo_list", version: 1, attrs: {}, children: [BAD, "blk-missing-0001"] },
        [BAD]: { id: BAD, type: "todo_item", version: 1, attrs: { checked: "yes", text: "Odd" } },
      }),
    )
    expect(html).toContain('<li class="todo-item"><input type="checkbox" disabled="" readOnly="" aria-label="Odd"/><span class="todo-item__text">Odd</span></li>')
    expect(html.match(/<li/g)).toHaveLength(1)
  })
})
