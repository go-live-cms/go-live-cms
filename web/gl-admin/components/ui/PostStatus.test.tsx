import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The status pill (#338), "Changes not published" for a published post whose working
// copy differs from the live one (#326), and a scheduled post's time (#147): "Scheduled ·
// Nov 3" in the site's time zone, one settings request for every pill on the page.

const getSettings = vi.fn()
vi.mock("@gl-admin/lib/api/settings", () => ({ getSettings: () => getSettings() }))

import PostStatus, { PostStatusPill } from "./PostStatus"
import { resetSiteDateSettings } from "@gl-admin/lib/hooks/useSiteSettings"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const pill = (markup: string) => {
  const el = document.createElement("div")
  el.innerHTML = markup
  return el.querySelector(".gl-pill")
}

describe("PostStatus", () => {
  it("names the status, with its tone", () => {
    const published = pill(renderToStaticMarkup(<PostStatusPill status="published" />))
    expect(published?.textContent).toBe("Published")
    expect(published?.classList.contains("gl-pill--success")).toBe(true)
    expect(pill(renderToStaticMarkup(<PostStatusPill status="draft" />))?.textContent).toBe("Draft")
  })

  it("says Changes not published for a published post with unpublished changes", () => {
    const changed = pill(renderToStaticMarkup(<PostStatusPill status="published" unpublishedChanges />))
    expect(changed?.textContent).toBe("Changes not published")
    expect(changed?.classList.contains("gl-pill--accent")).toBe(true)
    expect(pill(renderToStaticMarkup(<PostStatus status="published" iconPath="published" unpublishedChanges />))?.textContent).toBe(
      "Changes not published"
    )
  })

  it("ignores the flag on any other status", () => {
    expect(pill(renderToStaticMarkup(<PostStatusPill status="draft" unpublishedChanges />))?.textContent).toBe("Draft")
    expect(pill(renderToStaticMarkup(<PostStatusPill status="archived" unpublishedChanges />))?.textContent).toBe("Archived")
  })

  it("is a skeleton while the row loads", () => {
    const markup = renderToStaticMarkup(<PostStatus status={null} iconPath={null} unpublishedChanges />)
    expect(markup).toContain("gl-skeleton")
    expect(markup).not.toContain("Changes not published")
  })
})

describe("PostStatus for a scheduled post", () => {
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

  it("keeps the bare status without a time", async () => {
    await render(
      <>
        <PostStatusPill status="draft" />
        <PostStatusPill status="scheduled" />
      </>
    )
    expect(container.textContent).toBe("DraftScheduled")
  })
})

// A published post's scheduled update (#335): "Update scheduled · Nov 3", in place of
// "Changes not published".
describe("PostStatus for a scheduled update", () => {
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

  it("shows the update's day in the site's zone, over the changes flag", async () => {
    const year = new Date().getUTCFullYear()
    await act(async () =>
      root.render(
        <>
          <PostStatus status="published" iconPath="published" unpublishedChanges updateAt={`${year}-11-04T01:30:00Z`} />
          <PostStatusPill status="published" updateAt={`${year}-11-04T01:30:00Z`} withTime />
        </>
      )
    )
    const pills = [...container.querySelectorAll(".gl-pill")]
    expect(pills.map((p) => p.textContent)).toEqual(["Update scheduled · Nov 3", "Update scheduled · Nov 3, 22:30"])
    expect(pills[0].classList.contains("gl-pill--info")).toBe(true)
  })

  it("is only for published posts", async () => {
    await act(async () => root.render(<PostStatusPill status="draft" updateAt="2026-11-04T01:30:00Z" />))
    expect(container.textContent).toBe("Draft")
  })
})
