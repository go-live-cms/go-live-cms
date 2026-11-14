import { act, useState, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Modal from "./Modal"
import Drawer from "./Drawer"
import Table from "./Table"
import { installInputModality } from "./a11y"
import { SidebarNav } from "@gl-admin/components/sidebar/Sidebar"
import { buildNavigation } from "@gl-admin/components/sidebar/nav"

// Page structure (#480): dialogs make the page behind them inert, the active-option cue
// follows the input modality, the sidebar's sections are labelled groups, table rows
// carry no aria-selected.

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

describe("dialogs make the page behind them inert", () => {
  function Page({ drawer = false }: { drawer?: boolean }) {
    const [open, setOpen] = useState(false)
    const [inner, setInner] = useState(false)
    const Dialog = drawer ? Drawer : Modal
    return (
      <>
        <aside id="sidebar">
          <a href="/">Home</a>
        </aside>
        <main id="page">
          <p id="text">Posts</p>
          <button type="button" id="opener" onClick={() => setOpen(true)}>
            Invite
          </button>
          <Dialog isOpen={open} onClose={() => setOpen(false)} title="Invite people">
            <button type="button" id="inner-opener" onClick={() => setInner(true)}>
              More
            </button>
            <Modal isOpen={inner} onClose={() => setInner(false)} title="Details">
              <button type="button" id="inner-close" onClick={() => setInner(false)}>
                Done
              </button>
            </Modal>
          </Dialog>
        </main>
        <div id="toaster" data-inert-exempt="" />
      </>
    )
  }
  const $ = (id: string) => document.getElementById(id)!

  for (const drawer of [false, true]) {
    it(`${drawer ? "Drawer" : "Modal"}: everything but the dialog and the toaster, then back, with focus on the opener`, async () => {
      await render(<Page drawer={drawer} />)
      $("opener").focus()
      await act(async () => $("opener").click())
      expect($("sidebar").hasAttribute("inert")).toBe(true)
      expect($("text").hasAttribute("inert")).toBe(true)
      expect($("opener").hasAttribute("inert")).toBe(true)
      expect($("toaster").hasAttribute("inert")).toBe(false)
      expect(document.querySelector("[role='dialog']")!.closest("[inert]")).toBeNull()

      // A dialog opened from the dialog: the first one's content goes inert too, and
      // closing the inner one gives it back.
      await act(async () => $("inner-opener").click())
      expect($("inner-opener").closest("[inert]")).not.toBeNull()
      await act(async () => $("inner-close").click())
      expect($("inner-opener").closest("[inert]")).toBeNull()
      expect($("sidebar").hasAttribute("inert")).toBe(true)

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      })
      expect(document.querySelectorAll("[inert]")).toHaveLength(0)
      expect(document.activeElement).toBe($("opener"))
    })
  }

  it("never marks the block editor's view, and leaves an element's own inert alone", async () => {
    await render(
      <>
        <div id="own" inert />
        <div id="canvas">
          <div className="ProseMirror" contentEditable suppressContentEditableWarning />
        </div>
        <Modal isOpen onClose={() => {}} title="Insert link">
          <input aria-label="URL" />
        </Modal>
      </>
    )
    expect(document.getElementById("canvas")!.hasAttribute("inert")).toBe(false)
    await act(async () => root.render(<div id="own" inert />))
    expect(document.getElementById("own")!.hasAttribute("inert")).toBe(true)
  })
})

describe("input modality (the active option's ring)", () => {
  it("says keyboard after a key and pointer after a press or a real move", () => {
    installInputModality()
    const root = document.documentElement
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }))
    expect(root.dataset.inputModality).toBe("keyboard")
    document.dispatchEvent(new Event("pointerdown"))
    expect(root.dataset.inputModality).toBe("pointer")
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }))
    expect(root.dataset.inputModality).toBe("pointer")
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }))
    // A synthetic move (the list scrolled under a still pointer) doesn't count.
    document.dispatchEvent(new MouseEvent("mousemove", { movementX: 0, movementY: 0 } as MouseEventInit))
    expect(root.dataset.inputModality).toBe("keyboard")
    document.dispatchEvent(new MouseEvent("mousemove", { movementX: 3, movementY: 1 } as MouseEventInit))
    expect(root.dataset.inputModality).toBe("pointer")
  })
})

describe("sidebar sections", () => {
  it("are groups named by their label", async () => {
    const sections = buildNavigation({ role: "admin", postTypes: undefined, taxonomyTypes: [] })
    await render(
      <MemoryRouter>
        <SidebarNav sections={sections} current={null} onSearch={() => {}} />
      </MemoryRouter>
    )
    const groups = Array.from(container.querySelectorAll<HTMLElement>("nav [role='group']"))
    const names = groups.map((g) => document.getElementById(g.getAttribute("aria-labelledby")!)?.textContent)
    expect(names).toEqual(sections.filter((s) => s.label).map((s) => s.label))
    expect(names.length).toBeGreaterThan(0)
  })
})

describe("Table", () => {
  it("leaves the selected state to the row's checkbox", async () => {
    type Row = { id: number; title: string }
    await render(
      <Table<Row>
        columns={[{ key: "title", name: "Title" }]}
        data={[{ id: 1, title: "Spring launch" }]}
        selectable
        selectedKeys={[1]}
        onSelectionChange={() => {}}
      />
    )
    expect(container.querySelector("tr[aria-selected]")).toBeNull()
  })
})
