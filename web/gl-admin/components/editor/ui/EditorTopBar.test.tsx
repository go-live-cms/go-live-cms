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
function renderBar(postStatus: string, settingsPending: boolean, contentPending = false, schedule: Record<string, unknown> = {}) {
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
          onArchive={async () => {}}
          {...schedule}
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

// Scheduled publishing (#147): the Publish menu's Schedule… / Reschedule… and Cancel
// schedule, and the pill with the time.
describe("EditorTopBar scheduling", () => {
  const openMenu = () => {
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="More publish options"]')!
    act(() => toggle.click())
    return [...document.body.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? "")
  }

  it("offers Schedule… on a draft, next to Publish now", () => {
    renderBar("draft", false, false, { onSchedule: noop })
    const items = openMenu()
    expect(items.some((i) => i.startsWith("Publish now"))).toBe(true)
    expect(items.some((i) => i.startsWith("Schedule…"))).toBe(true)
    expect(items.some((i) => i.startsWith("Cancel schedule"))).toBe(false)
  })

  it("offers Reschedule… and Cancel schedule on a scheduled post, and Publish still works", () => {
    renderBar("scheduled", false, false, { onSchedule: noop, onCancelSchedule: async () => {}, publishAt: "2026-11-03T12:00:00Z" })
    expect(container.textContent).toContain("Publish")
    expect(container.textContent).toContain("Scheduled")
    const items = openMenu()
    expect(items.some((i) => i.startsWith("Publish now"))).toBe(true)
    expect(items.some((i) => i.startsWith("Reschedule…"))).toBe(true)
    expect(items.some((i) => i.startsWith("Cancel schedule"))).toBe(true)
  })

  it("doesn't offer it on a published post", () => {
    renderBar("published", false, false, { onSchedule: noop })
    expect(openMenu().some((i) => i.includes("chedule"))).toBe(false)
  })
})

// Scheduled updates (#335): a published post's Update menu offers Schedule update…,
// then Reschedule update… and Cancel update; the pill shows the time.
describe("EditorTopBar scheduled update", () => {
  const menuItems = () => {
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="More publish options"]')!
    act(() => toggle.click())
    return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  }
  const item = (items: HTMLElement[], label: string) => items.find((i) => (i.textContent ?? "").startsWith(label))

  it("offers Schedule update… on a published post with changes not published", async () => {
    const onScheduleUpdate = vi.fn()
    renderBar("published", false, true, { onScheduleUpdate })
    const items = menuItems()
    const schedule = item(items, "Schedule update…")
    expect(schedule).toBeDefined()
    expect(schedule!.getAttribute("aria-disabled")).toBeNull()
    expect(item(items, "Cancel update")).toBeUndefined()
    act(() => schedule!.click())
    expect(onScheduleUpdate).toHaveBeenCalledOnce()
  })

  it("can't schedule an update when the live post already matches", () => {
    renderBar("published", false, false, { onScheduleUpdate: noop })
    const schedule = item(menuItems(), "Schedule update…")
    expect(schedule?.getAttribute("aria-disabled")).toBe("true")
    expect(schedule?.textContent).toContain("already matches")
  })

  it("shows the scheduled time and offers Reschedule update… and Cancel update", async () => {
    const onCancelScheduledUpdate = vi.fn(async () => {})
    renderBar("published", false, true, {
      onScheduleUpdate: noop,
      onCancelScheduledUpdate,
      // This year's, so the pill leaves the year out.
      updateAt: `${new Date().getUTCFullYear()}-11-03T09:00:00Z`,
    })
    // The settings load is async: let the pill read the zone.
    await act(async () => {})
    expect(statusPill()).toBe("Update scheduled · Nov 3, 09:00")
    expect(container.querySelector(".editor-top-bar__split-main")?.textContent).toBe("Update now")
    const items = menuItems()
    expect(item(items, "Update now")?.textContent).toContain("cancel the scheduled update")
    expect(item(items, "Reschedule update…")).toBeDefined()
    const cancel = item(items, "Cancel update")
    expect(cancel).toBeDefined()
    await act(async () => cancel!.click())
    expect(onCancelScheduledUpdate).toHaveBeenCalledOnce()
  })

  it("is only for published posts", () => {
    renderBar("draft", false, false, { onScheduleUpdate: noop, onCancelScheduledUpdate: async () => {}, updateAt: "2026-11-03T09:00:00Z" })
    const items = menuItems()
    expect(item(items, "Schedule update…")).toBeUndefined()
    expect(item(items, "Cancel update")).toBeUndefined()
    expect(statusPill()).toBe("Draft")
  })
})
