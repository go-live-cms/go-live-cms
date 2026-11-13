import { act, useState, type ReactElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import axe from "axe-core"
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import Menu, { MenuItem, MenuSeparator } from "./Menu"
import Modal from "./Modal"
import Pagination from "./Pagination"
import Select from "./Select"
import Switch from "./Switch"
import Tabs from "./Tabs"
import BubbleMenu from "@gl-admin/components/editor/ui/BubbleMenu"
import CommandSelect from "@gl-admin/components/editor/ui/CommandSelect"
import FeaturedImage from "@gl-admin/components/editor/ui/FeaturedImage"

// Automated accessibility checks (#144): axe-core on the shared UI components and the
// editor chrome fixed under #144, rendered with react-dom into jsdom, so a regression in
// roles, names or ARIA wiring fails CI. jsdom does no layout, so the rules that need it
// (contrast; the design tokens' contrast is tokens.test.ts) are off, as is "region" (a
// component is checked on its own, not as a page).

vi.mock("@gl-admin/contexts/GoLiveContext", () => ({ useGoLive: () => ({ isDark: false }) }))
vi.mock("@tiptap/react/menus", () => ({
  BubbleMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
// The picker is a dialog of its own (checked with Modal); here only what opens it.
vi.mock("@gl-admin/components/media/MediaPicker", () => ({ default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(ui: ReactElement) {
  await act(async () => root.render(ui))
}

/** axe's WCAG 2.x A/AA and best-practice rules over `context`; returns the violations. */
async function violations(context: Element = document.body) {
  const result = await axe.run(context, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    rules: {
      "color-contrast": { enabled: false },
      region: { enabled: false },
      // A component is rendered without a page around it: no <h1>, no <main>.
      "page-has-heading-one": { enabled: false },
      "landmark-one-main": { enabled: false },
    },
  })
  return result.violations.map((v) => ({
    id: v.id,
    help: v.help,
    nodes: v.nodes.map((n) => n.html),
  }))
}

describe("axe: shared UI components (#144)", () => {
  it("Pagination: a labelled nav, named page buttons, the current page", async () => {
    const fetchData = vi.fn(async ({ offset }: { limit: number; offset: number }) => ({
      data: Array.from({ length: 8 }, (_, i) => offset + i),
      total: 30,
    }))
    await render(
      <Pagination fetchData={fetchData} query={{}}>
        {({ data }) => <ul>{data.map((n) => <li key={n}>Row {n}</li>)}</ul>}
      </Pagination>
    )
    const nav = container.querySelector("nav[aria-label='Pagination']")!
    expect(nav).not.toBeNull()
    expect([...nav.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(
      expect.arrayContaining(["First page", "Previous page", "Page 1", "Next page", "Last page"])
    )
    expect(nav.querySelector("[aria-current='page']")?.textContent).toBe("1")
    expect(await violations(container)).toEqual([])
  })

  it("Menu, open", async () => {
    await render(
      <Menu label="Post actions" trigger={(props) => <button {...props}>Actions</button>}>
        <MenuItem onSelect={() => {}}>Open</MenuItem>
        <MenuSeparator />
        <MenuItem disabled onSelect={() => {}}>
          Archive
        </MenuItem>
        <MenuItem danger onSelect={() => {}}>
          Move to trash
        </MenuItem>
      </Menu>
    )
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click())
    expect(document.querySelector("[role='menu']")).not.toBeNull()
    expect(await violations()).toEqual([])
  })

  it("Modal, open", async () => {
    await render(
      <Modal isOpen onClose={() => {}} title="Invite people">
        <label htmlFor="axe-email">Email</label>
        <input id="axe-email" type="email" />
      </Modal>
    )
    expect(document.querySelector("[role='dialog'], [role='alertdialog']")).not.toBeNull()
    expect(await violations()).toEqual([])
  })

  it("Tabs, Switch and Select", async () => {
    function Controls() {
      const [tab, setTab] = useState("all")
      const [on, setOn] = useState(false)
      const [size, setSize] = useState("8")
      return (
        <>
          <Tabs
            label="Views"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "all", label: "All", count: 3, panel: <p>All posts</p> },
              { id: "trash", label: "Trash", count: 1, panel: <p>Trashed posts</p> },
            ]}
          />
          <Switch checked={on} onChange={setOn} label="Highlight changes" />
          <Select
            label="Rows per page"
            value={size}
            onChange={setSize}
            options={[
              { value: "8", label: "8" },
              { value: "16", label: "16" },
            ]}
          />
        </>
      )
    }
    await render(<Controls />)
    expect(await violations(container)).toEqual([])
  })
})

describe("axe: editor chrome (#144)", () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: Object.values(schemaExtensions({ collaborating: false })),
      content: {
        type: "doc",
        content: [{ type: "paragraph", attrs: { "data-block-id": "blk-0144-axe-000001" }, content: [{ type: "text", text: "alpha beta" }] }],
      },
    })
  })
  afterEach(() => editor.destroy())

  it("the selection toolbar", async () => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 6)))
    await render(<BubbleMenu editor={editor} openLinkModal={() => {}} />)
    expect(container.querySelector("[role='toolbar']")).not.toBeNull()
    expect(await violations(container)).toEqual([])
  })

  it("a toolbar picker, open", async () => {
    await render(
      <div role="toolbar" aria-label="Block">
        <CommandSelect
          label="Block type"
          value="paragraph"
          onChange={() => {}}
          options={[
            { value: "paragraph", label: "Paragraph" },
            { value: "heading-2", label: "Heading 2" },
          ]}
        />
      </div>
    )
    await act(async () => container.querySelector<HTMLButtonElement>(".editor-select__trigger")!.click())
    expect(container.querySelector("[role='listbox']")).not.toBeNull()
    expect(await violations(container)).toEqual([])
  })

  it("the featured image field: its placeholder is a named button", async () => {
    await render(<FeaturedImage value={null} onChange={() => {}} postId={1} />)
    const placeholder = container.querySelector<HTMLElement>("[role='button'][aria-label='Set featured image']")
    expect(placeholder?.tabIndex).toBe(0)
    expect(await violations(container)).toEqual([])
  })
})
