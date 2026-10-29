import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The invite dialog (#343): every role is a card with what it may do, Contributor is
// picked first, and the chosen role is what gets sent.

const api = vi.hoisted(() => ({ createInvitation: vi.fn() }))
vi.mock("@gl-admin/lib/api/invitations", () => ({ createInvitation: api.createInvitation }))

import InviteUserModal from "./InviteUserModal"
import { ROLE_DESCRIPTIONS } from "@gl-admin/lib/roles"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const onInvited = vi.fn()

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

async function render() {
  await act(async () => root.render(<InviteUserModal isOpen onClose={() => {}} onInvited={onInvited} />))
  await settle()
}

const dialog = () => document.querySelector<HTMLElement>("[role='dialog']")!
const cards = () =>
  Array.from(dialog().querySelectorAll<HTMLLabelElement>("fieldset label.gl-choice")).map((label) => ({
    name: label.querySelector(".gl-choice__label")?.textContent,
    description: label.querySelector(".gl-choice__description")?.textContent,
    checked: label.querySelector("input")!.checked,
  }))

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.createInvitation.mockReset()
  onInvited.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("InviteUserModal", () => {
  it("describes each role, with Contributor selected", async () => {
    await render()
    expect(dialog().querySelector("fieldset legend")?.textContent).toBe("Role")
    expect(cards()).toEqual([
      { name: "Contributor", description: ROLE_DESCRIPTIONS.contributor, checked: true },
      { name: "Editor", description: ROLE_DESCRIPTIONS.editor, checked: false },
      { name: "Administrator", description: ROLE_DESCRIPTIONS.admin, checked: false },
    ])
  })

  it("sends the role picked", async () => {
    api.createInvitation.mockResolvedValue({ invitation: { email: "tom@example.com" }, email_sent: true })
    await render()
    await type(dialog().querySelector<HTMLInputElement>("input[id='input-email']")!, " tom@example.com ")
    await act(async () => dialog().querySelector<HTMLInputElement>("input[type='radio'][value='editor']")!.click())
    expect(cards().find((c) => c.checked)?.name).toBe("Editor")

    const send = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Send invite")!
    await act(async () => send.click())
    await settle()
    expect(api.createInvitation).toHaveBeenCalledWith({ email: "tom@example.com", role: "editor" })
    expect(onInvited).toHaveBeenCalled()
  })

  it("names the fix instead of sending an incomplete address", async () => {
    await render()
    await type(dialog().querySelector<HTMLInputElement>("input[id='input-email']")!, "maya@golive")
    const send = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Send invite")!
    await act(async () => send.click())
    await settle()
    expect(api.createInvitation).not.toHaveBeenCalled()
    expect(dialog().querySelector("[role='alert']")?.textContent).toBe("Enter the email address to invite.")
  })
})
