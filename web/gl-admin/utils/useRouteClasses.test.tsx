import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"
import { useRouteClasses } from "./useRouteClasses"

function Classes() {
  return <p id="classes">{useRouteClasses()}</p>
}

const classesAt = (path: string) => {
  const container = document.createElement("div")
  const root = createRoot(container)
  act(() =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Classes />
      </MemoryRouter>
    )
  )
  const classes = container.querySelector("#classes")?.textContent?.split(" ") ?? []
  act(() => root.unmount())
  return classes
}

// The editor's routes get admin-main--editor, which drops the page padding so the top bar
// sits flush and the settings panel reaches the right edge (#551).
describe("useRouteClasses", () => {
  it.each(["/content/post/new", "/content/page/new", "/content/product/new", "/content/edit/12", "/site-editor/templates/3"])(
    "%s is the editor",
    (path) => expect(classesAt(path)).toContain("admin-main--editor")
  )

  it.each(["/content/post", "/content", "/media", "/site-editor", "/site-editor/history"])("%s isn't", (path) =>
    expect(classesAt(path)).not.toContain("admin-main--editor")
  )
})
