import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The app shell's sidebar (#339): role-filtered links, and at phone width the
// off-canvas drawer, which traps focus, closes on Escape, the scrim or a link, and
// gives focus back to the menu button.

const auth = vi.hoisted(() => ({
  user: { id: 4, username: "luan", full_name: "Luan", email: "l@example.com", role: "admin" } as { role: string } & Record<string, unknown>,
}))

vi.mock("@gl-admin/lib/auth", () => ({
  authManager: {
    getState: () => ({ user: auth.user }),
    subscribe: () => () => {},
    logout: vi.fn(),
  },
}))
vi.mock("@gl-admin/lib/api/postTypes", () => ({
  getPostTypes: () =>
    Promise.resolve({
      data: [
        { name: "post", label: "Posts", menu_position: 5 },
        { name: "page", label: "Pages", menu_position: 20 },
      ],
    }),
}))
vi.mock("@gl-admin/lib/api/taxonomies", () => ({
  getTaxonomyTypes: () => Promise.resolve({ data: [{ name: "category", label: "Categories" }] }),
}))

import Sidebar from "./Sidebar"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let phone = true

beforeEach(() => {
  phone = true
  window.matchMedia = ((query: string) => ({
    matches: phone,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  auth.user.role = "admin"
})

function Where() {
  const { pathname } = useLocation()
  return <output data-testid="path">{pathname}</output>
}

async function render(ui: ReactElement, path = "/") {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                {ui}
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    )
  })
}

async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    ;(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }))
  })
}

async function click(el: Element) {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

const toggle = () => document.querySelector<HTMLButtonElement>('[aria-label="Open menu"]')!
const drawer = () => document.querySelector<HTMLElement>('[role="dialog"]')
const linkLabels = () => Array.from(document.querySelectorAll(".gl-sidebar__nav a")).map((a) => a.textContent)

describe("phone drawer", () => {
  it("opens from the menu button with focus inside, and closes on Escape back to the button", async () => {
    await render(<Sidebar />)
    expect(drawer()).toBeNull()

    toggle().focus()
    await click(toggle())
    expect(drawer()).not.toBeNull()
    expect(drawer()!.getAttribute("aria-modal")).toBe("true")
    expect(drawer()!.getAttribute("aria-label")).toBe("Menu")
    expect(toggle().getAttribute("aria-expanded")).toBe("true")
    expect(drawer()!.contains(document.activeElement)).toBe(true)

    await press("Escape")
    expect(drawer()).toBeNull()
    expect(document.activeElement).toBe(toggle())
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
  })

  it("keeps Tab and Shift+Tab inside the drawer", async () => {
    await render(<Sidebar />)
    toggle().focus()
    await click(toggle())

    const focusable = Array.from(drawer()!.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"))
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    // The floating close button comes last, after the account menu.
    expect(last.getAttribute("aria-label")).toBe("Close menu")

    last.focus()
    await press("Tab")
    expect(document.activeElement).toBe(first)

    await press("Tab", { shiftKey: true })
    expect(document.activeElement).toBe(last)

    // Focus that escaped (a click on the page behind) comes back on the next Tab.
    toggle().focus()
    await press("Tab")
    expect(drawer()!.contains(document.activeElement)).toBe(true)
  })

  it("closes when a link is followed, and on the close button, returning focus each time", async () => {
    await render(<Sidebar />)
    toggle().focus()
    await click(toggle())
    const media = Array.from(drawer()!.querySelectorAll("a")).find((a) => a.textContent === "Media")!
    await click(media)
    expect(document.querySelector('[data-testid="path"]')!.textContent).toBe("/media")
    expect(drawer()).toBeNull()
    expect(document.activeElement).toBe(toggle())

    await click(toggle())
    await click(drawer()!.querySelector('[aria-label="Close menu"]')!)
    expect(drawer()).toBeNull()
    expect(document.activeElement).toBe(toggle())
  })

  it("lets Escape close the open account menu first, then the drawer", async () => {
    await render(<Sidebar />)
    toggle().focus()
    await click(toggle())
    const account = drawer()!.querySelector<HTMLButtonElement>(".gl-sidebar__user")!
    account.focus()
    await click(account)
    expect(document.querySelector('[role="menu"]')).not.toBeNull()

    await press("Escape")
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(drawer()).not.toBeNull()

    await press("Escape")
    expect(drawer()).toBeNull()
  })

  it("titles the top bar after the current page", async () => {
    await render(<Sidebar />, "/media")
    expect(document.querySelector(".gl-mobile-bar__title")!.textContent).toBe("Media")
  })
})

describe("role-aware sidebar", () => {
  it("shows admins the workspace pages and marks the current one", async () => {
    phone = false
    await render(<Sidebar />, "/settings")
    expect(linkLabels()).toEqual(expect.arrayContaining(["Users", "Themes", "Settings", "Categories"]))
    expect(document.querySelector('[aria-current="page"]')!.textContent).toBe("Settings")
    // Desktop: a column, no drawer.
    expect(document.querySelector(".gl-shell__sidebar")).not.toBeNull()
  })

  it("hides Users, Settings, Themes and the taxonomies from contributors", async () => {
    phone = false
    auth.user.role = "contributor"
    await render(<Sidebar />)
    const labels = linkLabels()
    for (const hidden of ["Users", "Settings", "Themes", "Post types", "Categories"]) expect(labels).not.toContain(hidden)
    expect(labels).toEqual(expect.arrayContaining(["Home", "New post", "Posts", "Pages", "Media"]))
    expect(document.querySelector(".gl-sidebar__user-role")!.textContent).toBe("Contributor")
  })
})
