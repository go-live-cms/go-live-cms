import { act, useState, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Menu, { MenuItem, MenuSeparator } from "./Menu"
import Tabs from "./Tabs"
import Modal from "./Modal"
import Select from "./Select"
import { nextRovingIndex, typeaheadIndex } from "./a11y"

// Keyboard behaviour of the shared UI components (#338, patterns from #144): roving
// focus in menus and tabs, focus trap and Escape in dialogs. Rendered with react-dom
// into jsdom; keys are dispatched as native keydown events, as a browser would.

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

function render(ui: ReactElement) {
  act(() => root.render(ui))
}

// Async so pending work settles before the next assertion: floating-ui positions menus
// asynchronously, and a menu takes focus only once it is positioned (visible).
async function press(key: string, init: KeyboardEventInit = {}, target: Element | null = document.activeElement) {
  await act(async () => {
    ;(target ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }))
  })
}

async function click(el: Element) {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

const focused = () => document.activeElement as HTMLElement
const byRole = (role: string) => Array.from(document.querySelectorAll<HTMLElement>(`[role="${role}"]`))

describe("roving helpers", () => {
  it("moves with arrows, wraps, and jumps with Home and End", async () => {
    expect(nextRovingIndex("ArrowDown", 0, 3)).toBe(1)
    expect(nextRovingIndex("ArrowDown", 2, 3)).toBe(0)
    expect(nextRovingIndex("ArrowUp", 0, 3)).toBe(2)
    expect(nextRovingIndex("ArrowRight", 1, 3, "horizontal")).toBe(2)
    expect(nextRovingIndex("ArrowDown", 1, 3, "horizontal")).toBeNull()
    expect(nextRovingIndex("Home", 2, 3)).toBe(0)
    expect(nextRovingIndex("End", 0, 3)).toBe(2)
    expect(nextRovingIndex("a", 0, 3)).toBeNull()
  })

  it("finds the next label starting with a letter, after the current one", async () => {
    const labels = ["Open", "Duplicate", "Delete", "Archive"]
    expect(typeaheadIndex(labels, "d", 0)).toBe(1)
    expect(typeaheadIndex(labels, "D", 1)).toBe(2)
    expect(typeaheadIndex(labels, "d", 2)).toBe(1)
    expect(typeaheadIndex(labels, "x", 0)).toBeNull()
  })
})

describe("Menu", () => {
  const onSelect = vi.fn()

  function PostMenu() {
    return (
      <>
        <Menu label="Post actions" trigger={(props) => <button {...props}>Actions</button>}>
          <MenuItem onSelect={() => onSelect("open")}>Open</MenuItem>
          <MenuItem onSelect={() => onSelect("duplicate")}>Duplicate</MenuItem>
          <MenuSeparator />
          <MenuItem disabled onSelect={() => onSelect("archive")}>
            Archive
          </MenuItem>
          <MenuItem danger onSelect={() => onSelect("trash")}>
            Move to trash
          </MenuItem>
        </Menu>
        <button>After</button>
      </>
    )
  }

  const trigger = () => document.querySelector<HTMLButtonElement>("[aria-haspopup='menu']")!
  const menu = () => document.querySelector<HTMLElement>("[role='menu']")

  beforeEach(() => onSelect.mockReset())

  it("opens on click with focus on the first item, and names itself", async () => {
    render(<PostMenu />)
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    await click(trigger())
    expect(menu()?.getAttribute("aria-label")).toBe("Post actions")
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
    expect(trigger().getAttribute("aria-controls")).toBe(menu()?.id)
    expect(focused().textContent).toBe("Open")
  })

  it("opens on ArrowDown at the first item and on ArrowUp at the last", async () => {
    render(<PostMenu />)
    trigger().focus()
    await press("ArrowDown")
    expect(focused().textContent).toBe("Open")
    await press("Escape")
    await press("ArrowUp")
    expect(focused().textContent).toBe("Move to trash")
  })

  it("moves with arrows, wraps, skips disabled items, and jumps with Home/End", async () => {
    render(<PostMenu />)
    await click(trigger())
    await press("ArrowDown")
    expect(focused().textContent).toBe("Duplicate")
    await press("ArrowDown") // Archive is disabled
    expect(focused().textContent).toBe("Move to trash")
    await press("ArrowDown")
    expect(focused().textContent).toBe("Open")
    await press("ArrowUp")
    expect(focused().textContent).toBe("Move to trash")
    await press("Home")
    expect(focused().textContent).toBe("Open")
    await press("End")
    expect(focused().textContent).toBe("Move to trash")
    // Items are not Tab stops: the menu has one entry point.
    expect(byRole("menuitem").every((el) => el.tabIndex === -1)).toBe(true)
  })

  it("jumps to the next item starting with a typed letter", async () => {
    render(<PostMenu />)
    await click(trigger())
    await press("m")
    expect(focused().textContent).toBe("Move to trash")
    await press("d")
    expect(focused().textContent).toBe("Duplicate")
  })

  it("closes on Escape and gives focus back to the trigger", async () => {
    render(<PostMenu />)
    await click(trigger())
    await press("Escape")
    expect(menu()).toBeNull()
    expect(focused()).toBe(trigger())
  })

  it("runs the item on Enter (a click), closes and refocuses the trigger", async () => {
    render(<PostMenu />)
    await click(trigger())
    await press("ArrowDown")
    await click(focused()) // Enter on a focused <button> fires click
    expect(onSelect).toHaveBeenCalledWith("duplicate")
    expect(menu()).toBeNull()
    expect(focused()).toBe(trigger())
  })

  it("doesn't run a disabled item", async () => {
    render(<PostMenu />)
    await click(trigger())
    await click(byRole("menuitem").find((el) => el.textContent === "Archive")!)
    expect(onSelect).not.toHaveBeenCalled()
    expect(menu()).not.toBeNull()
  })

  it("closes on Tab without pulling focus back", async () => {
    render(<PostMenu />)
    await click(trigger())
    await press("Tab")
    expect(menu()).toBeNull()
  })
})

describe("Tabs", () => {
  function Views({ activation, onChange }: { activation?: "automatic" | "manual"; onChange?: (id: string) => void }) {
    const [value, setValue] = useState("all")
    return (
      <Tabs
        label="Views"
        activation={activation}
        value={value}
        onChange={(id) => {
          onChange?.(id)
          setValue(id)
        }}
        tabs={[
          { id: "all", label: "All", count: 48 },
          { id: "published", label: "Published", count: 31 },
          { id: "drafts", label: "Drafts", disabled: true },
          { id: "trash", label: "Trash", count: 2, panel: <p>Trashed posts</p> },
        ]}
      />
    )
  }

  const tabs = () => byRole("tab")
  const selected = () => tabs().find((t) => t.getAttribute("aria-selected") === "true")

  it("is one Tab stop: only the selected tab is focusable", async () => {
    render(<Views />)
    expect(document.querySelector("[role='tablist']")?.getAttribute("aria-label")).toBe("Views")
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1, -1])
    expect(selected()?.textContent).toBe("All48")
  })

  it("selects as arrows move (automatic), wrapping and skipping disabled tabs", async () => {
    render(<Views />)
    tabs()[0].focus()
    await press("ArrowRight")
    expect(focused()).toBe(tabs()[1])
    expect(selected()).toBe(tabs()[1])
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1, -1])
    await press("ArrowRight") // Drafts is disabled
    expect(selected()?.textContent).toBe("Trash2")
    await press("ArrowRight")
    expect(selected()?.textContent).toBe("All48")
    await press("ArrowLeft")
    expect(selected()?.textContent).toBe("Trash2")
    await press("Home")
    expect(focused()).toBe(tabs()[0])
    await press("End")
    expect(focused()).toBe(tabs()[3])
  })

  it("links the selected tab to its panel", async () => {
    render(<Views />)
    await click(tabs()[3])
    const panel = document.querySelector("[role='tabpanel']")!
    expect(panel.textContent).toBe("Trashed posts")
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs()[3].id)
    expect(tabs()[3].getAttribute("aria-controls")).toBe(panel.id)
  })

  it("only moves focus with manual activation; selecting is a click", async () => {
    const onChange = vi.fn()
    render(<Views activation="manual" onChange={onChange} />)
    tabs()[0].focus()
    await press("ArrowRight")
    expect(focused()).toBe(tabs()[1])
    expect(onChange).not.toHaveBeenCalled()
    expect(selected()).toBe(tabs()[0])
    await click(focused())
    expect(onChange).toHaveBeenCalledWith("published")
  })
})

describe("Modal (dialog)", () => {
  function Page({ onClose }: { onClose?: () => void }) {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button onClick={() => setOpen(true)}>Invite people</button>
        <Modal
          isOpen={open}
          onClose={() => {
            onClose?.()
            setOpen(false)
          }}
          title="Invite people"
          description="They'll get an email with a link."
          footer={<button onClick={() => setOpen(false)}>Send invite</button>}
        >
          <input aria-label="Email addresses" />
          <Menu label="Role" trigger={(props) => <button {...props}>Role</button>}>
            <MenuItem onSelect={() => {}}>Editor</MenuItem>
          </Menu>
        </Modal>
      </>
    )
  }

  const opener = () => document.querySelector<HTMLButtonElement>("button")!
  const dialog = () => document.querySelector<HTMLElement>("[role='dialog']")
  const open = async () => {
    opener().focus()
    await click(opener())
  }

  it("is a labelled modal dialog with focus moved into its body", async () => {
    render(<Page />)
    await open()
    expect(dialog()?.getAttribute("aria-modal")).toBe("true")
    expect(document.getElementById(dialog()!.getAttribute("aria-labelledby")!)?.textContent).toBe("Invite people")
    expect(document.getElementById(dialog()!.getAttribute("aria-describedby")!)?.textContent).toContain("email")
    // The first control in the body, not the close button in the header.
    expect(focused().getAttribute("aria-label")).toBe("Email addresses")
  })

  it("traps Tab: from the last control to the first, Shift+Tab back", async () => {
    render(<Page />)
    await open()
    const controls = Array.from(dialog()!.querySelectorAll<HTMLElement>("button, input"))
    const first = controls[0]
    const last = controls[controls.length - 1]
    expect(first.getAttribute("aria-label")).toBe("Close")
    expect(last.textContent).toBe("Send invite")

    last.focus()
    await press("Tab")
    expect(focused()).toBe(first)
    await press("Tab", { shiftKey: true })
    expect(focused()).toBe(last)
    // Focus that escaped somehow is pulled back in.
    opener().focus()
    await press("Tab")
    expect(dialog()!.contains(focused())).toBe(true)
  })

  it("closes on Escape and returns focus to the opener", async () => {
    const onClose = vi.fn()
    render(<Page onClose={onClose} />)
    await open()
    await press("Escape")
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()
    expect(focused()).toBe(opener())
  })

  it("closes from the close button and the scrim", async () => {
    const onClose = vi.fn()
    render(<Page onClose={onClose} />)
    await open()
    await click(dialog()!.querySelector("[aria-label='Close']")!)
    expect(dialog()).toBeNull()
    await open()
    await act(async () => {
      document.querySelector(".gl-modal-overlay")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    })
    expect(dialog()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it("lets Escape close a menu inside it first, then the dialog", async () => {
    const onClose = vi.fn()
    render(<Page onClose={onClose} />)
    await open()
    const role = Array.from(dialog()!.querySelectorAll("button")).find((b) => b.textContent === "Role")!
    await click(role)
    expect(document.querySelector("[role='menu']")).not.toBeNull()
    await press("Escape")
    expect(document.querySelector("[role='menu']")).toBeNull()
    expect(dialog()).not.toBeNull()
    expect(focused()).toBe(role)
    await press("Escape")
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()
  })
})

describe("Select", () => {
  function RolePicker({ onChange }: { onChange: (v: string) => void }) {
    const [value, setValue] = useState("editor")
    return (
      <Select
        label="Role"
        value={value}
        onChange={(v) => {
          onChange(v)
          setValue(v)
        }}
        options={[
          { value: "admin", label: "Admin" },
          { value: "editor", label: "Editor" },
          { value: "contributor", label: "Contributor" },
        ]}
      />
    )
  }

  it("opens on ArrowDown at the selection, moves, picks with Enter and keeps focus", async () => {
    const onChange = vi.fn()
    render(<RolePicker onChange={onChange} />)
    const combo = document.querySelector<HTMLButtonElement>("[role='combobox']")!
    combo.focus()
    await press("ArrowDown")
    const active = () => document.getElementById(combo.getAttribute("aria-activedescendant")!)
    expect(active()?.textContent).toBe("Editor")
    await press("ArrowDown")
    expect(active()?.textContent).toBe("Contributor")
    await press("a") // typeahead
    expect(active()?.textContent).toBe("Admin")
    await press("Enter")
    expect(onChange).toHaveBeenCalledWith("admin")
    expect(document.querySelector("[role='listbox']")).toBeNull()
    expect(focused()).toBe(combo)
    expect(combo.textContent).toBe("Admin")
  })

  it("closes on Escape without changing the value", async () => {
    const onChange = vi.fn()
    render(<RolePicker onChange={onChange} />)
    const combo = document.querySelector<HTMLButtonElement>("[role='combobox']")!
    combo.focus()
    await press("ArrowDown")
    await press("ArrowDown")
    await press("Escape")
    expect(document.querySelector("[role='listbox']")).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})
