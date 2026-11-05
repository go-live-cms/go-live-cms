import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { User } from "@gl-admin/lib/api/types"

// The Owner field (#353, "Owner Â· Luan (you) Â· Transfer"): the owner's name, Transfer
// for admins only, and the dialog: the member picker (the remove dialog's, #333; only
// active members, never the current owner), the confirm line, "also replace me in the
// byline", and POST /posts/:id/transfer.

const api = vi.hoisted(() => ({
  getPostOwner: vi.fn(),
  transferPost: vi.fn(),
}))
const users = vi.hoisted(() => ({ getUsers: vi.fn() }))
vi.mock("@gl-admin/lib/api/posts", () => api)
vi.mock("@gl-admin/lib/api/users", () => users)
const PostOwner = (await import("./PostOwner")).default
const { ApiError } = await import("@gl-admin/lib/api/errors")

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const member = (id: number, full_name: string, role: string): User => ({
  id,
  username: full_name.split(" ")[0].toLowerCase(),
  full_name,
  email: `${full_name.split(" ")[0].toLowerCase()}@golive.dev`,
  role,
  created_at: "2026-01-01T00:00:00Z",
})
const luan = member(1, "Luan", "admin")
const ana = member(2, "Ana Costa", "contributor")
const reader = member(3, "Rui Leitor", "user")
const bea = member(4, "Bea Lima", "editor")

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.getPostOwner.mockReset().mockResolvedValue({ id: luan.id, username: luan.username, full_name: luan.full_name })
  api.transferPost.mockReset().mockResolvedValue({
    post: { id: 7, user_id: ana.id },
    owner: { id: ana.id, username: ana.username, full_name: ana.full_name },
    previous_owner_id: luan.id,
    authors: [],
    byline_changed: true,
  })
  users.getUsers.mockReset().mockResolvedValue({ data: [luan, ana, reader, bea], meta: { total: 4 } })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
})

async function mount(props: { canTransfer?: boolean; onTransferred?: (r: unknown) => void } = {}) {
  await act(async () => {
    root.render(<PostOwner postId={7} me={{ id: luan.id }} canTransfer={props.canTransfer ?? true} onTransferred={props.onTransferred} />)
  })
  await flush()
}

const transferButton = () => container.querySelector<HTMLButtonElement>(".post-owner__transfer")
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (label: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!

async function openDialog() {
  await act(async () => transferButton()!.click())
  await flush()
}

// Opens the picker with the keyboard, moves to `name` and picks it; returns the options shown.
async function pick(name: string) {
  const input = dialog()!.querySelector<HTMLInputElement>('input[role="combobox"]')!
  const key = (k: string) => act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })))
  await act(async () => input.focus())
  await key("ArrowDown")
  const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? "")
  const active = () => document.getElementById(input.getAttribute("aria-activedescendant") ?? "")?.textContent ?? ""
  for (let i = 0; i < options.length && !active().includes(name); i++) await key("ArrowDown")
  expect(active()).toContain(name)
  await key("Enter")
  return options
}

describe("PostOwner", () => {
  it("shows the owner, (you) for yourself", async () => {
    await mount()
    expect(api.getPostOwner).toHaveBeenCalledWith(7)
    expect(container.querySelector(".post-owner__name")?.textContent).toBe("Luan (you)")
    expect(transferButton()?.textContent).toBe("Transfer")
  })

  it("has no Transfer button for anyone but admins", async () => {
    await mount({ canTransfer: false })
    expect(container.querySelector(".post-owner__name")?.textContent).toBe("Luan (you)")
    expect(transferButton()).toBeNull()
  })

  it("transfers to an active member, with the confirm line, keeping the byline", async () => {
    const onTransferred = vi.fn()
    await mount({ onTransferred })
    await openDialog()
    expect(dialog()?.textContent).toContain("Transfer this post")
    expect(button("Transfer").disabled).toBe(true)

    // Never the current owner, never a member without a content role.
    const options = await pick("Bea Lima")
    expect(options).toHaveLength(2)
    expect(options[0]).toContain("Ana Costa")
    expect(options[1]).toContain("Bea Lima")
    expect(options.join(" ")).not.toContain("Rui Leitor")
    expect(options.join(" ")).not.toContain("Luan")

    // Picked Bea, then changed to Ana.
    expect(dialog()?.textContent).toContain("Bea Lima will own this post. You keep your place in the byline.")
    await pick("Ana Costa")
    expect(dialog()?.textContent).toContain("Ana Costa will own this post. You keep your place in the byline.")

    await act(async () => button("Transfer").click())
    await flush()
    expect(api.transferPost).toHaveBeenCalledWith(7, ana.id, false)
    expect(dialog()).toBeNull()
    expect(container.querySelector(".post-owner__name")?.textContent).toBe("Ana Costa")
    expect(container.textContent).toContain("Ana Costa owns this post now and is in the byline.")
    expect(onTransferred).toHaveBeenCalledWith(expect.objectContaining({ byline_changed: true }))
  })

  it("can replace you in the byline", async () => {
    await mount()
    await openDialog()
    await pick("Ana Costa")
    const checkbox = dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(checkbox.closest("label")?.textContent).toContain("Also replace me in the byline")
    await act(async () => checkbox.click())
    expect(dialog()?.textContent).toContain("Ana Costa will own this post. Ana Costa takes your place in the byline.")
    await act(async () => button("Transfer").click())
    await flush()
    expect(api.transferPost).toHaveBeenCalledWith(7, ana.id, true)
  })

  it("keeps the dialog open with the API's reason when it refuses", async () => {
    api.transferPost.mockRejectedValueOnce(new ApiError("Request failed.", 400, null, "invalid_owner"))
    const onTransferred = vi.fn()
    await mount({ onTransferred })
    await openDialog()
    await pick("Ana Costa")
    await act(async () => button("Transfer").click())
    await flush()
    expect(dialog()?.textContent).toContain("Choose an active member to own this post.")
    expect(container.querySelector(".post-owner__name")?.textContent).toBe("Luan (you)")
    expect(onTransferred).not.toHaveBeenCalled()
  })
})
