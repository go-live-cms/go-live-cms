import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import EditorTopBar from "./EditorTopBar"

// The scheduled pill reads the site's time zone.
vi.mock("@gl-admin/lib/api/settings", () => ({
  getSettings: async () => ({ site_language: "en-US", site_timezone: "UTC", date_format: "month_day_year" }),
}))

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
function renderBar(postStatus: string, settingsPending: boolean, schedule: Record<string, unknown> = {}) {
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
          onArchive={async () => {}}
          {...schedule}
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

// Scheduled publishing (#147): the Publish menu's Schedule… / Reschedule… and Cancel
// schedule, and the pill with the time.
describe("EditorTopBar scheduling", () => {
  const openMenu = () => {
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="More publish options"]')!
    act(() => toggle.click())
    return [...document.body.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? "")
  }

  it("offers Schedule… on a draft, next to Publish now", () => {
    renderBar("draft", false, { onSchedule: noop })
    const items = openMenu()
    expect(items.some((i) => i.startsWith("Publish now"))).toBe(true)
    expect(items.some((i) => i.startsWith("Schedule…"))).toBe(true)
    expect(items.some((i) => i.startsWith("Cancel schedule"))).toBe(false)
  })

  it("offers Reschedule… and Cancel schedule on a scheduled post, and Publish still works", () => {
    renderBar("scheduled", false, { onSchedule: noop, onCancelSchedule: async () => {}, publishAt: "2026-11-03T12:00:00Z" })
    expect(container.textContent).toContain("Publish")
    expect(container.textContent).toContain("Scheduled")
    const items = openMenu()
    expect(items.some((i) => i.startsWith("Publish now"))).toBe(true)
    expect(items.some((i) => i.startsWith("Reschedule…"))).toBe(true)
    expect(items.some((i) => i.startsWith("Cancel schedule"))).toBe(true)
  })

  it("doesn't offer it on a published post", () => {
    renderBar("published", false, { onSchedule: noop })
    expect(openMenu().some((i) => i.includes("chedule"))).toBe(false)
  })
})
