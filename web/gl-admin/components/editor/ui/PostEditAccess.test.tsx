import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PostAccess } from "@gl-admin/lib/api/postAccess"

// Edit access requests (#321) in the editor: the view-only notice's Request access (a
// dialog with an optional message, then "Request sent"), the reviewers' Grant / Decline,
// and Remove on the post settings' list.

const api = vi.hoisted(() => ({
  requestPostAccess: vi.fn(),
  grantAccessRequest: vi.fn(),
  declineAccessRequest: vi.fn(),
  revokePostAccess: vi.fn(),
}))
vi.mock("@gl-admin/lib/api/postAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gl-admin/lib/api/postAccess")>()),
  ...api,
}))
const { ViewOnlyNotice, AccessRequestsNotice, PostCollaborators } = await import("./PostEditAccess")
const { ApiError } = await import("@gl-admin/lib/api/errors")

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const kenji = { id: 5, username: "kenji", full_name: "Kenji Tanaka" }

const access = (overrides: Partial<PostAccess> = {}): PostAccess => ({
  can_edit: false,
  collaborator: false,
  can_request: true,
  request: null,
  can_review: false,
  pending: null,
  collaborators: null,
  ...overrides,
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  for (const fn of Object.values(api)) fn.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ""
})

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)
const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)))

function type(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
  setter.call(textarea, value)
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
}

describe("ViewOnlyNotice", () => {
  it("asks for edit access with a message, then re-reads the access", async () => {
    const onChanged = vi.fn()
    api.requestPostAccess.mockResolvedValue({ id: 4, status: "pending" })
    await act(async () => root.render(<ViewOnlyNotice postId={9} access={access()} onChanged={onChanged} />))
    expect(container.textContent).toContain("View-only:")

    await act(async () => button("Request access")!.click())
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Request edit access")
    await act(async () => type(document.querySelector("textarea")!, "I'd like to fix the typos."))
    await act(async () => button("Send request")!.click())
    await flush()
    expect(api.requestPostAccess).toHaveBeenCalledWith(9, "I'd like to fix the typos.")
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it("shows a pending request as sent, with no way to ask twice", async () => {
    await act(async () =>
      root.render(
        <ViewOnlyNotice
          postId={9}
          access={access({ can_request: false, request: { id: 4, post_id: 9, status: "pending", message: "", created_at: "", reviewed_at: null } })}
          onChanged={() => {}}
        />
      )
    )
    expect(button("Request access")).toBeUndefined()
    expect(button("Request sent")?.disabled).toBe(true)
    expect(container.textContent).toContain("You asked for edit access.")
  })

  it("has no button when edit access can't be asked for", async () => {
    await act(async () => root.render(<ViewOnlyNotice postId={9} access={access({ can_request: false })} onChanged={() => {}} />))
    expect(container.querySelector("button")).toBeNull()
  })

  it("keeps the dialog open with the API's reason when the request is refused", async () => {
    const onChanged = vi.fn()
    api.requestPostAccess.mockRejectedValue(new ApiError("conflict", 409, null, "request_open"))
    await act(async () => root.render(<ViewOnlyNotice postId={9} access={access()} onChanged={onChanged} />))
    await act(async () => button("Request access")!.click())
    await act(async () => button("Send request")!.click())
    await flush()
    expect(api.requestPostAccess).toHaveBeenCalledWith(9, "")
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("You already asked for edit access to this post.")
    // The open request it found is shown once the access is re-read.
    expect(onChanged).toHaveBeenCalled()
  })
})

describe("AccessRequestsNotice", () => {
  const pending = [{ id: 41, post_id: 9, status: "pending" as const, message: "Fix the numbers?", created_at: "", reviewed_at: null, requester: kenji }]

  it("grants or declines a request", async () => {
    const onChanged = vi.fn()
    api.grantAccessRequest.mockResolvedValue({ id: 41, status: "granted" })
    await act(async () => root.render(<AccessRequestsNotice postId={9} pending={pending} onChanged={onChanged} />))
    expect(container.textContent).toContain("Kenji Tanaka asked for edit access")
    expect(container.textContent).toContain("Fix the numbers?")
    await act(async () => button("Grant")!.click())
    await flush()
    expect(api.grantAccessRequest).toHaveBeenCalledWith(9, 41)
    expect(onChanged).toHaveBeenCalledTimes(1)

    api.declineAccessRequest.mockResolvedValue({ id: 41, status: "declined" })
    await act(async () => button("Decline")!.click())
    await flush()
    expect(api.declineAccessRequest).toHaveBeenCalledWith(9, 41)
  })

  it("shows nothing without open requests", async () => {
    await act(async () => root.render(<AccessRequestsNotice postId={9} pending={[]} onChanged={() => {}} />))
    expect(container.innerHTML).toBe("")
  })
})

describe("PostCollaborators", () => {
  it("removes a member's edit access", async () => {
    const onChanged = vi.fn()
    api.revokePostAccess.mockResolvedValue(undefined)
    await act(async () =>
      root.render(<PostCollaborators postId={9} collaborators={[{ ...kenji, granted_at: "2026-11-04T10:00:00Z" }]} onChanged={onChanged} />)
    )
    expect(container.textContent).toContain("Kenji Tanaka")
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove Kenji Tanaka\'s edit access"]')!.click())
    await flush()
    expect(api.revokePostAccess).toHaveBeenCalledWith(9, 5)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })
})
