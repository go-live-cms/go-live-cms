import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import ReviewRequestNotice from "./ReviewRequestNotice"
import EditorTopBar from "./EditorTopBar"
import ReviewRequestedPill from "@gl-admin/components/content/ReviewRequestedPill"
import type { ReviewRequest } from "@gl-admin/lib/api/reviewRequests"

vi.mock("@gl-admin/lib/api/settings", () => ({
  getSettings: async () => ({ site_language: "en-US", site_timezone: "UTC", date_format: "month_day_year" }),
}))

// Review requests (#323) in the editor and the posts list: who gets which action, that
// each calls its handler, the top bar's Request review entry, and the row's indicator.

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

const kenji = { id: 4, username: "kenji", full_name: "Kenji Tanaka", avatar: null }
const ana = { id: 2, username: "ana", full_name: "Ana Costa", avatar: null }
const open: ReviewRequest = {
  id: 1,
  post_id: 12,
  status: "open",
  message: "Ready for a look",
  resolution_note: "",
  created_at: "2026-10-27T10:00:00Z",
  resolved_at: null,
  requested_by: kenji,
  reviewer: ana,
  resolved_by: null,
}

function renderNotice(request: ReviewRequest | null, viewer: { id: number; canReview: boolean; canRequest: boolean }, published = false) {
  const handlers = { onPublish: vi.fn(), onRequestChanges: vi.fn(), onDismiss: vi.fn(), onRequestAgain: vi.fn() }
  act(() => root.render(<ReviewRequestNotice request={request} viewer={viewer} published={published} connected busy={false} {...handlers} />))
  return handlers
}
const buttons = () => Array.from(container.querySelectorAll("button")).map((b) => b.textContent)
const click = (label: string) => {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label)
  expect(button, label).toBeTruthy()
  act(() => button!.click())
}

describe("ReviewRequestNotice", () => {
  it("shows nothing without a request", () => {
    renderNotice(null, { id: 2, canReview: true, canRequest: true })
    expect(container.innerHTML).toBe("")
  })

  it("gives the reviewer Approve and publish, Request changes and Dismiss", () => {
    const h = renderNotice(open, { id: 2, canReview: true, canRequest: true })
    expect(container.textContent).toContain("Kenji Tanaka asked you for a review")
    expect(container.querySelector("q")?.textContent).toBe("Ready for a look")
    expect(buttons()).toEqual(["Approve and publish", "Request changes", "Dismiss"])
    click("Approve and publish")
    click("Request changes")
    click("Dismiss")
    expect(h.onPublish).toHaveBeenCalledOnce()
    expect(h.onRequestChanges).toHaveBeenCalledOnce()
    expect(h.onDismiss).toHaveBeenCalledOnce()
  })

  it("says Approve and update on a published post", () => {
    renderNotice(open, { id: 2, canReview: true, canRequest: true }, true)
    expect(buttons()[0]).toBe("Approve and update")
  })

  it("lets the requester withdraw", () => {
    const h = renderNotice(open, { id: 4, canReview: false, canRequest: true })
    expect(container.textContent).toContain("Review requested from Ana Costa")
    expect(buttons()).toEqual(["Withdraw request"])
    click("Withdraw request")
    expect(h.onDismiss).toHaveBeenCalledOnce()
  })

  it("shows the note after changes are requested, with Request review again", () => {
    const h = renderNotice(
      { ...open, status: "changes_requested", resolution_note: "Tighten the intro.", resolved_by: ana, resolved_at: "2026-10-28T09:00:00Z" },
      { id: 4, canReview: false, canRequest: true }
    )
    expect(container.querySelector(".gl-notice--warning")).not.toBeNull()
    expect(container.textContent).toContain("Ana Costa requested changes")
    expect(container.textContent).toContain("Tighten the intro.")
    click("Request review again")
    expect(h.onRequestAgain).toHaveBeenCalledOnce()
  })
})

describe("EditorTopBar: Request review", () => {
  const noop = () => {}
  function renderBar(props: { canPublish: boolean; reviewRequested?: boolean; onRequestReview?: () => void }) {
    act(() =>
      root.render(
        <MemoryRouter>
          <EditorTopBar
            listLabel="Posts"
            listHref="/content/post"
            title="A post"
            postStatus="draft"
            mode="edit"
            saveStatus={null}
            connection="online"
            live
            collabUsers={[]}
            viewOnly={false}
            isPublishing={false}
            isSaving={false}
            settingsOpen={false}
            onSettingsToggle={noop}
            onSave={noop}
            onPublish={noop}
            {...props}
          />
        </MemoryRouter>
      )
    )
  }

  it("gives anyone who can't publish a Request review button instead of Publish", () => {
    const onRequestReview = vi.fn()
    renderBar({ canPublish: false, onRequestReview })
    expect(buttons()).not.toContain("Publish")
    click("Request review")
    expect(onRequestReview).toHaveBeenCalledOnce()
  })

  it("shows the pending review instead, once asked", () => {
    renderBar({ canPublish: false, reviewRequested: true, onRequestReview: vi.fn() })
    expect(buttons()).not.toContain("Request review")
    expect(container.querySelector(".editor-top-bar__crumbs")?.textContent).toContain("Review requested")
  })

  it("keeps Publish for those who can, with no Request review button", () => {
    renderBar({ canPublish: true, onRequestReview: vi.fn() })
    expect(buttons()).toContain("Publish")
    expect(buttons()).not.toContain("Request review")
  })
})

describe("ReviewRequestedPill", () => {
  it("marks a row with an open request, saying who asked whom", () => {
    act(() => root.render(<ReviewRequestedPill summary={{ id: 1, created_at: "", requested_by: kenji, reviewer: ana }} meId={2} />))
    expect(container.querySelector(".gl-pill")?.textContent).toBe("Review requested")
    expect(container.textContent).toContain("Kenji Tanaka asked you for a review")
    expect(container.querySelector(".gl-review-pill")?.getAttribute("title")).toBe("Kenji Tanaka asked you for a review")
  })

  it("is nothing for a row without one", () => {
    act(() => root.render(<ReviewRequestedPill summary={undefined} meId={2} />))
    expect(container.innerHTML).toBe("")
  })
})
