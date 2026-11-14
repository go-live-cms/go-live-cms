import { StrictMode, act, useEffect, useState, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ROUTE_FOCUS_WAIT_MS, useRouteFocus } from "./useRouteFocus"
import { adminTitle, usePageTitle } from "./usePageTitle"
import { editorHeading } from "@gl-admin/lib/editorHeading"

// Route changes (#480): every page sets its own document.title, and after a navigation
// focus moves to the new page's <h1> (or <main>), as AppLayout wires it.

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
  vi.useRealTimers()
})

let go: (path: string) => void = () => {}
function Navigator() {
  const navigate = useNavigate()
  go = (path) => navigate(path)
  return null
}

function Page({ title, children }: { title: string; children?: ReactElement }) {
  usePageTitle(title)
  return (
    <>
      <h1>{title}</h1>
      {children}
    </>
  )
}

// A page whose heading is replaced once it has loaded (a loading state's first).
function Loading() {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setLoaded(true), 50)
    return () => clearTimeout(t)
  }, [])
  usePageTitle(loaded ? "Spring launch" : "Loading…")
  return loaded ? <h1 key="post">Spring launch</h1> : <h1 key="loading">Loading…</h1>
}

function NoHeading() {
  usePageTitle("Bare")
  return <p>Nothing here</p>
}

function AutoFocus() {
  usePageTitle("Search")
  return (
    <>
      <h1>Search</h1>
      <input aria-label="Search" autoFocus />
    </>
  )
}

function Shell() {
  useRouteFocus("main-content")
  return (
    <>
      <nav>
        <button type="button" id="nav-link">
          Link
        </button>
      </nav>
      <main id="main-content">
        <Routes>
          <Route path="/" element={<Page title="Home" />} />
          <Route path="/users" element={<Page title="Users" />} />
          <Route path="/loading" element={<Loading />} />
          <Route path="/bare" element={<NoHeading />} />
          <Route path="/search" element={<AutoFocus />} />
        </Routes>
      </main>
      <Navigator />
    </>
  )
}

async function start() {
  await act(async () =>
    root.render(
      // StrictMode, as the admin runs in dev: effects run twice.
      <StrictMode>
        <MemoryRouter initialEntries={["/"]}>
          <Shell />
        </MemoryRouter>
      </StrictMode>
    )
  )
}

async function navigate(path: string) {
  document.getElementById("nav-link")!.focus()
  await act(async () => go(path))
}

describe("titles", () => {
  it("each page sets its own title, without the old one lingering", async () => {
    await start()
    expect(document.title).toBe("GoLive Admin | Home")
    await navigate("/users")
    expect(document.title).toBe("GoLive Admin | Users")
    await navigate("/bare")
    expect(document.title).toBe("GoLive Admin | Bare")
  })

  it("formats the title and the editor's heading", () => {
    expect(adminTitle("GoLive Admin | ", "My profile")).toBe("GoLive Admin | My profile")
    expect(editorHeading("edit", "post", "Spring launch")).toBe("Edit post: Spring launch")
    expect(editorHeading("edit", "page", "  ")).toBe("Edit page: Untitled")
    expect(editorHeading("create", undefined)).toBe("New post")
    expect(editorHeading("create", "recipe")).toBe("New recipe")
  })

  // The routes' own pages, read from the source: each sets a title (usePageTitle), or
  // is one of the error pages (which set theirs). New routes are covered automatically.
  it("every routed page calls usePageTitle", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const admin = resolve(here, "../..")
    const app = readFileSync(resolve(admin, "app.tsx"), "utf8")
    const pages = new Set<string>()
    for (const m of app.matchAll(/(?:from |import\()"(?:\.\/|@gl-admin\/)pages\/([\w/]+)"/g)) pages.add(m[1])
    expect(pages.size).toBeGreaterThan(15)
    const missing = [...pages].filter((page) => {
      const source = readFileSync(resolve(admin, "pages", `${page}.tsx`), "utf8")
      return !source.includes("usePageTitle(") && !source.includes("components/errors/ErrorPages")
    })
    expect(missing).toEqual([])
  })
})

describe("focus after a route change", () => {
  it("leaves the first load alone", async () => {
    const before = document.activeElement
    await start()
    expect(document.activeElement).toBe(before)
  })

  it("moves to the new page's <h1>, which draws no ring and isn't a Tab stop after", async () => {
    await start()
    await navigate("/users")
    const h1 = container.querySelector("h1")!
    expect(document.activeElement).toBe(h1)
    expect(h1.hasAttribute("data-route-focus")).toBe(true)
    act(() => h1.blur())
    expect(h1.hasAttribute("tabindex")).toBe(false)
    expect(h1.hasAttribute("data-route-focus")).toBe(false)
  })

  it("follows a loading heading to the page's own", async () => {
    vi.useFakeTimers()
    await start()
    await navigate("/loading")
    expect(document.activeElement?.textContent).toBe("Loading…")
    await act(async () => {
      vi.advanceTimersByTime(60)
    })
    expect(document.activeElement?.textContent).toBe("Spring launch")
  })

  it("falls back to <main> when the page has no heading", async () => {
    vi.useFakeTimers()
    await start()
    await navigate("/bare")
    await act(async () => {
      vi.advanceTimersByTime(ROUTE_FOCUS_WAIT_MS + 1)
    })
    expect(document.activeElement).toBe(document.getElementById("main-content"))
  })

  it("keeps focus a page put somewhere itself", async () => {
    await start()
    await navigate("/search")
    expect(document.activeElement).toBe(container.querySelector("input"))
  })
})
