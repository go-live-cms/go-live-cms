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
import SegmentedControl from "./SegmentedControl"
import BubbleMenu from "@gl-admin/components/editor/ui/BubbleMenu"
import CommandSelect from "@gl-admin/components/editor/ui/CommandSelect"
import FeaturedImage from "@gl-admin/components/editor/ui/FeaturedImage"
import { MemoryRouter } from "react-router-dom"
import EditorTopBar from "@gl-admin/components/editor/ui/EditorTopBar"
import AddBlockMenu from "@gl-admin/components/editor/ui/AddBlockMenu"
import BlockTypeToolbar from "@gl-admin/components/editor/ui/BlockTypeToolbar"
import { ShortcutReferenceDialog } from "@gl-admin/components/editor/ui/ShortcutReference"
import { CORE_BLOCKS } from "@gl-admin/components/editor/blocks/catalog"
import Input from "./Input"
import Combobox from "./Combobox"
import Tooltip from "./Tooltip"
import Drawer from "./Drawer"
import { Toaster, dismissToast, toast } from "./Toast"
import { SidebarNav } from "@gl-admin/components/sidebar/Sidebar"
import { buildNavigation } from "@gl-admin/components/sidebar/nav"
import SiteEditorTopBar from "@gl-admin/components/site-editor/SiteEditorTopBar"
import { NewTemplateDialog } from "@gl-admin/components/site-editor/SiteDesignDialogs"

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
// The top bar's status pill reads the site's time zone.
vi.mock("@gl-admin/lib/api/settings", () => ({
  getSettings: async () => ({ site_language: "en-US", site_timezone: "UTC", date_format: "month_day_year" }),
}))
vi.mock("@gl-admin/lib/hooks/useAuthUser", () => ({ useAuthUser: () => null }))

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

describe("axe: forms, feedback and structure (#479, #480)", () => {
  it("Input with an error, and two unnamed inputs (no duplicate ids)", async () => {
    await render(
      <form>
        <Input title="Email" unmasked value="maya@golive" onChange={() => {}} error="“maya@golive” isn't a complete email address." />
        <Input title="Display name" unmasked hint="Shown on your posts." />
        <Input title="Nickname" unmasked />
      </form>
    )
    expect(container.querySelector("[role='alert']")).not.toBeNull()
    expect(await violations(container)).toEqual([])
  })

  it("Combobox, open", async () => {
    await render(
      <Combobox
        label="New owner"
        value={null}
        onChange={() => {}}
        options={[
          { value: "1", label: "Ana Costa" },
          { value: "2", label: "Kenji Sato" },
        ]}
      />
    )
    const input = container.querySelector<HTMLInputElement>("[role='combobox']")!
    input.focus()
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    })
    expect(input.getAttribute("aria-activedescendant")).not.toBeNull()
    expect(await violations(container)).toEqual([])
  })

  // The page Template field's list (#494): named groups of options, a tag on some.
  it("SegmentedControl: a fieldset of native radios, with a hidden legend too (#527)", async () => {
    await render(
      <div>
        <SegmentedControl
          legend="Replies"
          options={[
            { value: "replies", label: "Threaded" },
            { value: "flat", label: "Flat" },
          ]}
          value="replies"
          onChange={() => {}}
          hint="Threaded shows a reply under its comment."
        />
        <h3 id="axe-discussion-h">Discussion</h3>
        <SegmentedControl
          legend="Discussion"
          hideLegend
          block
          options={[
            { value: "default", label: "Default" },
            { value: "open", label: "Open" },
          ]}
          value="open"
          onChange={() => {}}
        />
      </div>
    )
    const groups = container.querySelectorAll("fieldset")
    expect(groups).toHaveLength(2)
    expect(groups[0].querySelectorAll("input[type='radio']")).toHaveLength(2)
    expect(groups[1].querySelector<HTMLInputElement>("input[value='open']")!.checked).toBe(true)
    expect(await violations(container)).toEqual([])
  })

  it("Select with grouped, tagged options, open", async () => {
    await render(
      <Select
        label="Template"
        value="block:landing"
        onChange={() => {}}
        options={[
          { value: "default", label: "Default", group: "Paper’s layouts" },
          { value: "fullwidth", label: "Full width", description: "Edge to edge", group: "Paper’s layouts" },
          { value: "block:landing", label: "Landing", tag: "Site editor", group: "Made in the Site editor" },
        ]}
      />
    )
    const trigger = container.querySelector<HTMLButtonElement>("[role='combobox']")!
    await act(async () => trigger.click())
    expect(document.querySelectorAll("[role='listbox'] > [role='group'][aria-labelledby]")).toHaveLength(2)
    expect(await violations()).toEqual([])
  })

  it("Toaster with an error and an action", async () => {
    await render(<Toaster />)
    let ids: string[] = []
    await act(async () => {
      ids = [toast.error("Couldn't publish"), toast.success("Moved to trash", { action: { label: "Undo", onClick: () => {} } })]
    })
    expect(container.querySelectorAll(".gl-toast")).toHaveLength(2)
    expect(await violations(container)).toEqual([])
    await act(async () => ids.forEach(dismissToast))
  })

  it("Tooltip, shown, on a component", async () => {
    await render(
      <Tooltip content="Editing" detail="Click to jump to cursor">
        <button type="button">Ana Costa</button>
      </Tooltip>
    )
    await act(async () => {
      container.querySelector(".gl-tooltip-target")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }))
    })
    expect(document.querySelector("[role='tooltip']")).not.toBeNull()
    expect(await violations()).toEqual([])
  })

  it("the sidebar's labelled section groups", async () => {
    await render(
      <MemoryRouter>
        <SidebarNav sections={buildNavigation({ role: "admin", taxonomyTypes: [] })} current={null} onSearch={() => {}} />
      </MemoryRouter>
    )
    expect(container.querySelector("[role='group'][aria-labelledby]")).not.toBeNull()
    expect(await violations(container)).toEqual([])
  })

  it("a drawer over a page made inert", async () => {
    await render(
      <>
        <nav aria-label="Admin">
          <a href="/">Home</a>
        </nav>
        <p>Posts</p>
        <Drawer isOpen onClose={() => {}} title="Version history">
          <button type="button">Restore</button>
        </Drawer>
      </>
    )
    expect(container.querySelector("nav")!.hasAttribute("inert")).toBe(true)
    expect(await violations()).toEqual([])
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

// #477: the editor's announcements, the + menu, the block-type picker in a quote and the
// shortcut reference.
describe("axe: editor announcements and shortcuts (#477)", () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: Object.values(schemaExtensions({ collaborating: false })),
      content: {
        type: "doc",
        content: [
          { type: "paragraph", attrs: { "data-block-id": "blk-0477-axe-000001" }, content: [{ type: "text", text: "alpha" }] },
          {
            type: "blockquote",
            attrs: { "data-block-id": "blk-0477-axe-000002" },
            content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }],
          },
        ],
      },
    })
  })
  afterEach(() => editor.destroy())

  const topBar = (props: Partial<Parameters<typeof EditorTopBar>[0]> = {}) => (
    <MemoryRouter>
      <EditorTopBar
        listLabel="Posts"
        listHref="/content/post"
        title="A post"
        postStatus="draft"
        mode="edit"
        saveStatus="saved"
        connection="online"
        live
        collabUsers={[]}
        viewOnly={false}
        canPublish
        isPublishing={false}
        isSaving={false}
        settingsOpen={false}
        onSettingsToggle={() => {}}
        onSave={() => {}}
        onPublish={() => {}}
        {...props}
      />
    </MemoryRouter>
  )

  it("the top bar: one status region, whatever it shows (offline, view-only, History)", async () => {
    for (const props of [
      { connection: "offline" as const, unsyncedCount: 3 },
      { viewOnly: true },
      { connection: "ended" as const },
      { viewing: { label: "Viewing version", onBack: () => {}, onRestore: () => {} } },
    ]) {
      await render(topBar(props))
      expect(document.querySelectorAll("[data-testid='save-announcer'][role='status']")).toHaveLength(1)
      expect(await violations(container)).toEqual([])
    }
  })

  it("the + menu, open: a named dialog with its search and status", async () => {
    const anchor = { current: document.createElement("button") }
    document.body.appendChild(anchor.current)
    const target = { id: "blk-0477-axe-000001", pos: 0 }
    await render(<AddBlockMenu editor={editor} target={target} anchor={anchor} onClose={() => {}} entries={CORE_BLOCKS.slice(0, 6)} />)
    const dialog = document.querySelector("[role='dialog'][aria-label='Add a block']")
    expect(dialog?.querySelector("[role='status']")).not.toBeNull()
    expect(await violations(dialog!)).toEqual([])
    anchor.current.remove()
  })

  it("the block-type toolbar in a quote names the quote, and its icons are hidden", async () => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 11)))
    await render(<BlockTypeToolbar editor={editor} />)
    const trigger = container.querySelector(".editor-select__trigger")!
    expect(trigger.getAttribute("aria-label")).toBe("Block type: Quote")
    expect(trigger.textContent).toContain("Quote")
    for (const svg of container.querySelectorAll("button[aria-label^='Align'] svg")) {
      expect(svg.getAttribute("aria-hidden")).toBe("true")
      expect(svg.getAttribute("focusable")).toBe("false")
    }
    expect(await violations(container)).toEqual([])
  })

  it("the shortcut reference, open", async () => {
    await render(<ShortcutReferenceDialog isOpen onClose={() => {}} />)
    const dialog = document.querySelector("[role='dialog']")!
    expect(dialog.textContent).toContain("Keyboard shortcuts")
    expect(await violations()).toEqual([])
  })
})

describe("axe: the Site editor (#493)", () => {
  const topBar = (props: Partial<Parameters<typeof SiteEditorTopBar>[0]> = {}) => (
    <MemoryRouter>
      <SiteEditorTopBar
        kind="template"
        name="Archive"
        pill={{ label: "Customized · changes not published", tone: "accent" }}
        viewOnly={false}
        saveStatus="saved"
        connection="online"
        unsyncedCount={0}
        collabUsers={[{ clientId: 7, id: 2, name: "Ana Costa" }]}
        me={{ id: 1, name: "Luan" }}
        onJumpToCursor={() => true}
        view="split"
        onViewChange={() => {}}
        settingsOpen
        onSettingsToggle={() => {}}
        actions={[
          { id: "history", label: "History" },
          { id: "discard", label: "Discard changes…" },
          { id: "reset", label: "Reset to theme default…" },
        ]}
        onAction={() => {}}
        publishCount={3}
        onPublish={() => {}}
        back={{ label: "Single post", to: "/site-editor/templates/1" }}
        {...props}
      />
    </MemoryRouter>
  )

  it("the template editor's top bar: a breadcrumb, one status region, a named View switch and Publish", async () => {
    for (const props of [{}, { viewOnly: true, connection: "offline" as const }]) {
      await render(topBar(props))
      expect(document.querySelectorAll("[data-testid='save-announcer'][role='status']")).toHaveLength(1)
      expect(container.querySelector("[role='group'][aria-label='View']")).not.toBeNull()
      expect(container.querySelector("button[aria-label='Publish site design, 3 changes']")).not.toBeNull()
      expect(container.querySelector("[aria-current='page']")!.textContent).toBe("Archive")
      expect(await violations(container)).toEqual([])
    }
  })

  it("New page template and New part, open, with a name that can't be used", async () => {
    for (const kind of ["template", "part"] as const) {
      await render(<NewTemplateDialog isOpen onClose={() => {}} kind={kind} themeName="Paper" taken={new Set()} onCreate={async () => {}} />)
      const input = document.querySelector<HTMLInputElement>("[role='dialog'] input")!
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
        setter.call(input, "★★★")
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
      expect(document.querySelector("[role='dialog']")!.textContent).toContain("Use at least one letter or number.")
      expect(input.getAttribute("aria-invalid")).toBe("true")
      expect(await violations()).toEqual([])
    }
  })
})
