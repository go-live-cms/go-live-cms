import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import EditorTopBar from "./EditorTopBar"

// The top bar says when a published post's settings (title, excerpt, featured image,
// terms) wait for Update (#358). The full "Changes not published" status is #326.

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
function renderBar(postStatus: string, settingsPending: boolean) {
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
        />
      </MemoryRouter>
    )
  )
  return container.querySelector('[role="status"]')?.textContent ?? ""
}

describe("EditorTopBar settings state", () => {
  it("says a published post's settings go live on Update", () => {
    expect(renderBar("published", true)).toBe("Saved · settings go live on Update")
    expect(container.textContent).toContain("Update")
  })

  it("says nothing extra when they match the live ones, or the post is a draft", () => {
    expect(renderBar("published", false)).toBe("Saved")
    expect(renderBar("draft", true)).toBe("Saved")
  })
})
