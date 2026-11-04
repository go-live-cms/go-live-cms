import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Profile (#334): the photo (pick, crop, upload, remove), the email change dialog and
// "Sign out of other devices", with their error states.

const usersApi = vi.hoisted(() => ({
  getMe: vi.fn(),
  updateUser: vi.fn(),
  uploadAvatar: vi.fn(),
  removeAvatar: vi.fn(),
  requestEmailChange: vi.fn(),
}))
vi.mock("@gl-admin/lib/api/users", () => usersApi)
const sessionsApi = vi.hoisted(() => ({ getMyDevices: vi.fn(), signOutOtherDevices: vi.fn() }))
vi.mock("@gl-admin/lib/api/sessions", () => sessionsApi)

const auth = vi.hoisted(() => ({
  getState: vi.fn(() => ({ user: null })),
  setUser: vi.fn(),
  subscribe: () => () => {},
  adoptAccessToken: vi.fn(),
  logout: vi.fn(),
}))
vi.mock("@gl-admin/lib/auth", () => ({ authManager: auth, AuthManager: { getInstance: () => auth } }))

import Profile from "./Profile"
import { ApiError } from "@gl-admin/lib/api/errors"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AVATAR = "/uploads/media/_avatars/avatar-0123456789abcdef0123456789abcdef.jpg"
const NEW_AVATAR = "/uploads/media/_avatars/avatar-fedcba9876543210fedcba9876543210.jpg"
const ME = { id: 4, username: "luan", full_name: "Luan", email: "luan@golive.dev", role: "admin", created_at: "", bio: "", website: "", avatar: null as string | null }

let container: HTMLDivElement
let root: Root

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
  })

const button = (label: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label
  )

const click = async (el: HTMLElement | undefined | null) => {
  expect(el).toBeTruthy()
  await act(async () => el!.click())
  await settle()
}

const dialog = () => document.querySelector<HTMLElement>("[aria-modal='true']")
const avatarImg = () => container.querySelector<HTMLImageElement>(".gl-profile__photo .gl-avatar img")

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

async function pickFile(file: File) {
  const input = container.querySelector<HTMLInputElement>("[data-testid='avatar-file']")!
  Object.defineProperty(input, "files", { value: [file], configurable: true })
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })))
  await settle()
}

async function renderProfile(user = ME) {
  usersApi.getMe.mockResolvedValue({ user })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    )
  )
  await settle()
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionsApi.getMyDevices.mockResolvedValue({ sessions: [], other_count: 2 })
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() }))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

describe("profile photo", () => {
  it("shows the initial without a photo, and no Remove", async () => {
    await renderProfile()
    expect(avatarImg()).toBeNull()
    expect(container.querySelector(".gl-profile__photo .gl-avatar")!.textContent).toBe("L")
    expect(button("Upload photo")).toBeTruthy()
    expect(button("Remove")).toBeUndefined()
    expect(container.textContent).toContain("Your colour in shared posts comes from your account")
  })

  it("crops around the picked point, uploads, and shows the new photo everywhere", async () => {
    await renderProfile()
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "me.png", { type: "image/png" })
    await pickFile(file)
    expect(dialog()?.textContent).toContain("Profile photo")
    expect(usersApi.uploadAvatar).not.toHaveBeenCalled()

    usersApi.uploadAvatar.mockResolvedValue({ user: { ...ME, avatar: NEW_AVATAR } })
    await click(button("Save photo", dialog()!))

    expect(usersApi.uploadAvatar).toHaveBeenCalledWith(file, { x: 0.5, y: 0.5 })
    expect(dialog()).toBeNull()
    expect(avatarImg()?.getAttribute("src")).toBe(NEW_AVATAR)
    // The sidebar and the next collaboration connection read the cached user.
    expect(auth.setUser).toHaveBeenCalledWith(expect.objectContaining({ avatar: NEW_AVATAR }))
    expect(button("Remove")).toBeTruthy()
  })

  it("refuses a file that isn't an image before uploading", async () => {
    await renderProfile()
    await pickFile(new File(["hello"], "notes.txt", { type: "text/plain" }))
    expect(dialog()).toBeNull()
    expect(container.textContent).toContain("Use a JPEG, PNG, GIF or WebP image.")
    expect(usersApi.uploadAvatar).not.toHaveBeenCalled()
  })

  it("refuses a file over 5 MB before uploading", async () => {
    await renderProfile()
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.jpg", { type: "image/jpeg" })
    await pickFile(big)
    expect(dialog()).toBeNull()
    expect(container.textContent).toContain("under 5 MB")
  })

  it("keeps the dialog open with the API's reason when the upload fails", async () => {
    await renderProfile()
    await pickFile(new File([new Uint8Array([1])], "me.png", { type: "image/png" }))
    usersApi.uploadAvatar.mockRejectedValue(new ApiError("Request failed.", 400, null, "avatar_unreadable"))
    await click(button("Save photo", dialog()!))
    expect(dialog()?.textContent).toContain("isn't an image we can read")
    expect(auth.setUser).not.toHaveBeenCalled()
  })

  it("removes the photo", async () => {
    await renderProfile({ ...ME, avatar: AVATAR })
    expect(avatarImg()?.getAttribute("src")).toBe(AVATAR)
    usersApi.removeAvatar.mockResolvedValue({ user: { ...ME, avatar: null } })
    await click(button("Remove"))
    expect(usersApi.removeAvatar).toHaveBeenCalled()
    expect(avatarImg()).toBeNull()
    expect(button("Remove")).toBeUndefined()
  })

  it("never renders an avatar URL that isn't one of the API's", async () => {
    await renderProfile({ ...ME, avatar: "https://tracker.example/pixel.gif" })
    expect(avatarImg()).toBeNull()
  })
})

describe("change email", () => {
  async function openDialog() {
    await renderProfile()
    expect(container.textContent).toContain("luan@golive.dev")
    await click(button("Change email"))
    const d = dialog()!
    expect(d.textContent).toContain("Change email")
    return {
      d,
      email: d.querySelector<HTMLInputElement>("#gl-change-email-new")!,
      password: d.querySelector<HTMLInputElement>("#gl-change-email-password")!,
    }
  }

  it("checks the fields before sending", async () => {
    const { d, email, password } = await openDialog()
    await act(async () => typeInto(email, "LUAN@golive.dev"))
    await act(async () => typeInto(password, "secret-secret"))
    await click(button("Send link", d))
    expect(d.textContent).toContain("That's already your email address.")
    expect(usersApi.requestEmailChange).not.toHaveBeenCalled()

    await act(async () => typeInto(email, "not-an-email"))
    await click(button("Send link", d))
    expect(d.textContent).toContain("Enter a valid email address.")

    await act(async () => typeInto(email, "new@golive.dev"))
    await act(async () => typeInto(password, ""))
    await click(button("Send link", d))
    expect(d.textContent).toContain("Enter your current password.")
  })

  it("says when the password is wrong", async () => {
    const { d, email, password } = await openDialog()
    usersApi.requestEmailChange.mockRejectedValue(new ApiError("Request failed.", 403, null, "current_password_incorrect"))
    await act(async () => typeInto(email, "new@golive.dev"))
    await act(async () => typeInto(password, "wrong-password"))
    await click(button("Send link", d))
    expect(dialog()?.textContent).toContain("Your current password is incorrect.")
  })

  it("sends the link and says the email changes once it's opened", async () => {
    const { d, email, password } = await openDialog()
    usersApi.requestEmailChange.mockResolvedValue({ message: "ok", expires_in_seconds: 86400 })
    await act(async () => typeInto(email, " new@golive.dev "))
    await act(async () => typeInto(password, "secret-secret"))
    await click(button("Send link", d))

    expect(usersApi.requestEmailChange).toHaveBeenCalledWith("secret-secret", "new@golive.dev")
    expect(dialog()).toBeNull()
    expect(container.textContent).toContain("We sent a confirmation link to new@golive.dev")
    expect(container.textContent).toContain("expires in 24 hours")
    // Not changed yet.
    expect(container.querySelector(".gl-profile__email-value")!.textContent).toBe("luan@golive.dev")
  })
})

describe("other devices", () => {
  it("counts the other devices and signs them out", async () => {
    await renderProfile()
    expect(container.textContent).toContain("You're signed in on 2 other devices.")
    sessionsApi.signOutOtherDevices.mockResolvedValue({ signed_out: 2 })
    await click(button("Sign out of other devices"))
    expect(sessionsApi.signOutOtherDevices).toHaveBeenCalled()
    expect(container.textContent).toContain("Signed out of 2 other devices.")
    expect(container.textContent).toContain("You're not signed in anywhere else.")
    expect(button("Sign out of other devices")!.disabled).toBe(true)
  })

  it("explains an ended session", async () => {
    await renderProfile()
    sessionsApi.signOutOtherDevices.mockRejectedValue(new ApiError("Request failed.", 409, null, "session_not_active"))
    await click(button("Sign out of other devices"))
    expect(container.textContent).toContain("This browser's session has ended.")
    expect(button("Sign out of other devices")!.disabled).toBe(false)
  })

  it("still offers the button when the count can't be read", async () => {
    sessionsApi.getMyDevices.mockRejectedValue(new Error("offline"))
    await renderProfile()
    expect(container.textContent).toContain("This one stays signed in.")
    expect(button("Sign out of other devices")!.disabled).toBe(false)
  })

  it("with nobody else signed in, there's nothing to do", async () => {
    sessionsApi.getMyDevices.mockResolvedValue({ sessions: [], other_count: 0 })
    await renderProfile()
    expect(container.textContent).toContain("You're not signed in anywhere else.")
    expect(button("Sign out of other devices")!.disabled).toBe(true)
  })
})
