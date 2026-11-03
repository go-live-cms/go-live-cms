import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import EditorTopBar from "./EditorTopBar"

// The top bar says when a published post's settings (title, excerpt, featured image,
// terms) wait for Update (#358), and when its body does: "Changes not published" (#326).

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

const noop = () => {}
function renderBar(postStatus: string, settingsPending: boolean, contentPending = false) {
  act(() =>
    root.render(
      <MemoryRouter>
        <EditorTopBar
          listLabel="Posts"
          listHref="/content/post"
          title="A post"
          postStatus={postStatus}
          mode="edit"
          saveStatus={null}
          connection="online"
          live
          collabUsers={[]}
          viewOnly={false}
          canPublish
          isPublishing={false}
          isSaving={false}
          settingsOpen={false}
          onSettingsToggle={noop}
          onSave={noop}
          onPublish={noop}
          settingsPending={settingsPending}
          contentPending={contentPending}
        />
      </MemoryRouter>
    )
  )
  return container.querySelector('[role="status"]')?.textContent ?? ""
}
const statusPill = () => container.querySelector(".editor-top-bar__crumbs .gl-pill")?.textContent

describe("EditorTopBar settings state", () => {
  it("says a published post's settings go live on Update", () => {
    expect(renderBar("published", true)).toBe("Saved · settings go live on Update")
    expect(container.textContent).toContain("Update")
  })

  it("says nothing extra when they match the live ones, or the post is a draft", () => {
    expect(renderBar("published", false)).toBe("Saved")
    expect(statusPill()).toBe("Published")
    expect(renderBar("draft", true)).toBe("Saved")
    expect(statusPill()).toBe("Draft")
  })
})

// #326: the body too, from anyone's edits. Either half is "Changes not published".
describe("EditorTopBar: Changes not published", () => {
  it("says a published post's changes go live on Update, with the status pill", () => {
    expect(renderBar("published", false, true)).toBe("Saved · changes go live on Update")
    expect(statusPill()).toBe("Changes not published")
    expect(container.querySelector(".editor-top-bar__crumbs .gl-pill--accent")).not.toBeNull()
    expect(container.querySelector(".editor-top-bar__split-main")?.textContent).toBe("Update")
  })

  it("names the changes, not just the settings, when both are pending", () => {
    expect(renderBar("published", true, true)).toBe("Saved · changes go live on Update")
    expect(statusPill()).toBe("Changes not published")
  })

  it("marks settings-only changes as not published too", () => {
    renderBar("published", true, false)
    expect(statusPill()).toBe("Changes not published")
  })

  it("is only for published posts", () => {
    expect(renderBar("draft", false, true)).toBe("Saved")
    expect(statusPill()).toBe("Draft")
    expect(container.querySelector(".editor-top-bar__split-main")?.textContent).toBe("Publish")
    expect(renderBar("archived", true, true)).toBe("Saved")
    expect(statusPill()).toBe("Archived")
  })
})
