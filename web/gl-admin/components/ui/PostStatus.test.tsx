import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The status pill (#338) with a scheduled post's time (#147): "Scheduled · Nov 3" in the
// site's time zone, one settings request for every pill on the page.

const getSettings = vi.fn()
vi.mock("@gl-admin/lib/api/settings", () => ({ getSettings: () => getSettings() }))

import PostStatus, { PostStatusPill } from "./PostStatus"
import { resetSiteDateSettings } from "@gl-admin/lib/hooks/useSiteSettings"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  resetSiteDateSettings()
  getSettings.mockReset()
  getSettings.mockResolvedValue({ site_language: "en-US", site_timezone: "America/Sao_Paulo", date_format: "month_day_year" })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(node: React.ReactNode) {
  await act(async () => root.render(node))
}

describe("PostStatus", () => {
  it("shows a scheduled post's day in the site's zone", async () => {
    // 01:30 UTC on the 4th is 22:30 on the 3rd in São Paulo.
    const year = new Date().getUTCFullYear()
    await render(<PostStatus status="scheduled" iconPath="scheduled" publishAt={`${year}-11-04T01:30:00Z`} />)
    expect(container.textContent).toBe("Scheduled · Nov 3")
  })

  it("adds the time in the editor, and loads the settings once for many pills", async () => {
    const year = new Date().getUTCFullYear()
    await render(
      <>
        <PostStatusPill status="scheduled" publishAt={`${year}-11-04T01:30:00Z`} withTime />
        <PostStatusPill status="scheduled" publishAt={`${year}-11-05T12:00:00Z`} />
      </>
    )
    expect(container.textContent).toBe("Scheduled · Nov 3, 22:30Scheduled · Nov 5")
    expect(getSettings).toHaveBeenCalledTimes(1)
  })

  it("keeps the other statuses as they were", async () => {
    await render(
      <>
        <PostStatusPill status="draft" />
        <PostStatusPill status="scheduled" />
      </>
    )
    expect(container.textContent).toBe("DraftScheduled")
  })
})
