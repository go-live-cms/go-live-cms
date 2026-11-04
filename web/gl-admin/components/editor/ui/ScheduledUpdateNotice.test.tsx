import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import ScheduledUpdateNotice from "./ScheduledUpdateNotice"
import type { ScheduledUpdate } from "@gl-admin/lib/api/types"

// The editor's notice for a scheduled update (#335): the time in site time and that
// later changes aren't included, with Reschedule and Cancel update; after a failure, why
// and when it's tried again, with Update now. Only editors and admins get buttons.

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

const saoPaulo = { language: "en-US", timeZone: "America/Sao_Paulo" } as const
const now = new Date("2026-11-02T12:00:00Z")
const pending: ScheduledUpdate = {
  update_at: "2026-11-03T12:00:00Z",
  scheduled_at: "2026-11-02T11:00:00Z",
  scheduled_by: 3,
}

function render(update: ScheduledUpdate, props: { canPublish?: boolean; connected?: boolean } = {}) {
  const handlers = { onReschedule: vi.fn(), onCancel: vi.fn(), onUpdateNow: vi.fn() }
  act(() =>
    root.render(
      <ScheduledUpdateNotice
        update={update}
        settings={saoPaulo}
        canPublish={props.canPublish ?? true}
        connected={props.connected ?? true}
        now={now}
        {...handlers}
      />
    )
  )
  return handlers
}
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)

describe("ScheduledUpdateNotice", () => {
  it("names the time in site time and says later changes aren't included", () => {
    const { onReschedule, onCancel } = render(pending)
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    expect(container.textContent).toContain("Update scheduled for Nov 3, 09:00")
    expect(container.textContent).toContain("Sao Paulo time · later changes aren’t included; reschedule to include them.")
    act(() => button("Reschedule")!.click())
    act(() => button("Cancel update")!.click())
    expect(onReschedule).toHaveBeenCalledOnce()
    expect(onCancel).toHaveBeenCalledOnce()
    expect(button("Update now")).toBeUndefined()
  })

  it("needs the connection to reschedule (the snapshot is taken from the collab server)", () => {
    render(pending, { connected: false })
    expect(button("Reschedule")!.disabled).toBe(true)
    expect(button("Cancel update")!.disabled).toBe(false)
  })

  it("is read-only for someone who can't publish", () => {
    render(pending, { canPublish: false })
    expect(container.textContent).toContain("An editor scheduled the live post's update for this time")
    expect(container.querySelectorAll("button")).toHaveLength(0)
  })

  it("says a failed update is retried, and offers Update now", () => {
    const { onUpdateNow } = render({
      ...pending,
      failure: { failed_at: "2026-11-02T11:59:00Z", reason: "update_failed", attempts: 1, next_attempt_at: "2026-11-02T12:05:00Z" },
    })
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.textContent).toContain("Scheduled update failed")
    expect(container.textContent).toContain("the live post is unchanged. It's tried again automatically, next at 09:05.")
    act(() => button("Update now")!.click())
    expect(onUpdateNow).toHaveBeenCalledOnce()
    expect(button("Cancel update")).toBeDefined()
  })
})
