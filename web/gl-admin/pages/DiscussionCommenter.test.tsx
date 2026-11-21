import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

// A commenter's page (#526, 16.1): the address, counts, every comment, Block with who and
// when; the "isn't here anymore" page for one erased meanwhile; an admin's Export and Erase (#529),
// which an editor doesn't get.

const api = vi.hoisted(() => ({
  getCommenter: vi.fn(),
  setCommenterBlocked: vi.fn(),
  announceDiscussionChanged: vi.fn(),
  exportCommenter: vi.fn(),
  eraseCommenter: vi.fn(),
}))
const auth = vi.hoisted(() => ({ user: null as null | { id: number; role: string; username: string } }))
vi.mock("@gl-admin/lib/api/discussion", () => api)
vi.mock("@gl-admin/lib/auth", () => ({ authManager: { getState: () => ({ accessToken: "t", user: auth.user }), subscribe: () => () => {} } }))
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock("@gl-admin/components/ui/Toast", () => ({ toast: toasts }))

import DiscussionCommenter from "./DiscussionCommenter"
import { ApiError } from "@gl-admin/lib/api/errors"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SUMMARY = {
  id: 7,
  email: "maya.lindqvist@example.com",
  name: "Maya Lindqvist",
  names_used: ["M. Lindqvist", "Maya Lindqvist"],
  verified_at: "2026-11-16T12:00:00Z",
  blocked_at: null as string | null,
  blocked_by: "",
  last_spam_at: null,
  created_at: "2026-11-16T12:00:00Z",
  approved: 3,
  pending: 1,
  spam: 0,
  trash: 0,
  notify_count: 2,
  network_neighbours: 3,
}

let container: HTMLDivElement
let root: Root
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
  })

async function render() {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/discussion/commenters/7"]}>
        <Routes>
          <Route path="/discussion/commenters/:id" element={<DiscussionCommenter />} />
          <Route path="/discussion" element={<p>The queue</p>} />
        </Routes>
      </MemoryRouter>
    )
  )
  await settle()
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  Object.values(api).forEach((fn) => fn.mockReset())
  auth.user = null
  toasts.success.mockReset()
  toasts.error.mockReset()
  api.getCommenter.mockResolvedValue({ commenter: SUMMARY, comments: [] })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it("shows the address, the names used and the counts, and blocks", async () => {
  await render()
  expect(api.getCommenter).toHaveBeenCalledWith(7)
  expect(container.querySelector("h1")?.textContent).toBe("Maya Lindqvist")
  const text = container.textContent!
  expect(text).toContain("maya.lindqvist@example.com")
  expect(text).toContain("also posted as “M. Lindqvist”")
  expect(text).toContain("Replies by email on 2 comments.")
  expect(text).toContain("3 other commenters posted from this network in the last 30 days.")
  expect(Array.from(container.querySelectorAll(".gl-dq-stat")).map((s) => s.textContent)).toEqual(["Approved3", "Pending1", "Spam0", "Trash0"])
  expect(container.textContent).not.toContain("Export")

  api.setCommenterBlocked.mockResolvedValue({ ...SUMMARY, blocked_at: "2026-11-17T12:00:00Z", blocked_by: "Ana Costa" })
  const block = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Block")!
  await act(async () => block.click())
  await settle()
  expect(api.setCommenterBlocked).toHaveBeenCalledWith(7, true)
  expect(container.textContent).toContain("Blocked by Ana Costa on Nov 17")
  expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Unblock")).toBe(true)
})

const button = (label: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent === label)

it("gives an editor Block only: Export and Erase are an admin's", async () => {
  auth.user = { id: 2, role: "editor", username: "ed" }
  await render()
  expect(button("Block")).toBeTruthy()
  expect(button("Export")).toBeUndefined()
  expect(button("Erase")).toBeUndefined()
})

it("lets an admin export the commenter's file", async () => {
  auth.user = { id: 1, role: "admin", username: "admin" }
  const file = { commenter: { email: SUMMARY.email }, comments: [] }
  api.exportCommenter.mockResolvedValue(file)
  const created = vi.fn(() => "blob:x")
  const revoked = vi.fn()
  Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked })
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
  await render()
  await act(async () => button("Export")!.click())
  await settle()
  expect(api.exportCommenter).toHaveBeenCalledWith(7)
  expect(created).toHaveBeenCalledTimes(1)
  expect(clicked).toHaveBeenCalledTimes(1)
  expect((clicked.mock.contexts[0] as HTMLAnchorElement).download).toBe("commenter-7.json")
  await vi.waitFor(() => expect(revoked).toHaveBeenCalledWith("blob:x"), { timeout: 3000 })
  expect(toasts.success).toHaveBeenCalled()
  clicked.mockRestore()
})

it("asks before an admin erases, then leaves for the queue", async () => {
  auth.user = { id: 1, role: "admin", username: "admin" }
  api.eraseCommenter.mockResolvedValue({ comment_count: 4, tombstoned: 1 })
  await render()
  await act(async () => button("Erase")!.click())
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain("Delete Maya Lindqvist’s 4 comments and everything stored about this address?")
  expect(dialog.textContent).toContain(SUMMARY.email)
  expect(api.eraseCommenter).not.toHaveBeenCalled()

  // Cancel erases nothing.
  await act(async () => button("Cancel")!.click())
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(api.eraseCommenter).not.toHaveBeenCalled()

  await act(async () => button("Erase")!.click())
  const confirm = Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((b) => b.textContent === "Erase") as HTMLButtonElement
  await act(async () => confirm.click())
  await settle()
  expect(api.eraseCommenter).toHaveBeenCalledWith(7)
  expect(toasts.success).toHaveBeenCalledWith("Erased 4 comments. One became “This comment was removed”: replies answer it.")
  expect(api.announceDiscussionChanged).toHaveBeenCalled()
  expect(container.textContent).toContain("The queue")
})

it("keeps the page when the erasure fails", async () => {
  auth.user = { id: 1, role: "admin", username: "admin" }
  api.eraseCommenter.mockRejectedValue(new ApiError("failed to erase the commenter", 500, null, ""))
  await render()
  await act(async () => button("Erase")!.click())
  const confirm = Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((b) => b.textContent === "Erase") as HTMLButtonElement
  await act(async () => confirm.click())
  await settle()
  expect(toasts.error).toHaveBeenCalled()
  expect(container.querySelector("h1")?.textContent).toBe("Maya Lindqvist")
})

it("says when a commenter isn't here anymore", async () => {
  api.getCommenter.mockRejectedValue(new ApiError("commenter not found", 404, null, "commenter_not_found"))
  await render()
  expect(container.textContent).toContain("This commenter isn't here anymore")
})
